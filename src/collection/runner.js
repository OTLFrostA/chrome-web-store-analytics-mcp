import { listUserExtensions } from '../storage.js';
import { collectMetrics } from './metrics.js';
import { DEFAULT_KEYWORDS, searchWebStore } from './ranking.js';
import { saveRankingHistory } from './history.js';
import { readCollectorCredential, saveCollectorCredential, deleteCollectorCredential } from './credentials.js';
import { localDay, localHour } from './time.js';

async function collectRankings({ env, googleSub, item, now }) {
  const { results } = await env.MCP_DB.prepare(`SELECT keyword, locale FROM collector_keywords
    WHERE google_sub=? AND item_id=? AND enabled=1 ORDER BY keyword`).bind(googleSub, item.itemId).all();
  const keywords = results?.length ? results : DEFAULT_KEYWORDS.map(keyword => ({ keyword, locale: 'en-US' }));
  const rankings = [];
  for (const { keyword, locale } of keywords) {
    const found = await searchWebStore(keyword, locale);
    rankings.push(await saveRankingHistory(env.MCP_DB, googleSub, item.itemId, keyword, locale, found, now));
  }
  return { rowsWritten: rankings.length, rankings };
}

// New collectors only need to expose a stable ID and a collect function.
export const COLLECTORS = Object.freeze({
  'cws-analytics': { id: 'cws-analytics', schedule: { hourPT: 8 }, collect: collectMetrics },
  'cws-ranking': { id: 'cws-ranking', schedule: { hourPT: 8 }, collect: collectRankings },
});

export async function updateKeywords(db, googleSub, itemId, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > 20 ||
      keywords.some(x => typeof x !== 'string' || !x.trim() || x.length > 120)) {
    throw new Error('Specify between 1 and 20 non-empty keywords (max 120 characters each).');
  }
  const normalized = [...new Set(keywords.map(x => x.trim().toLowerCase()))];
  await db.batch([
    db.prepare('DELETE FROM collector_keywords WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    ...normalized.map(keyword => db.prepare(`INSERT INTO collector_keywords
      (google_sub, item_id, keyword, locale) VALUES (?, ?, ?, 'en-US')`).bind(googleSub, itemId, keyword)),
  ]);
  return normalized;
}

export async function enableDailyCollection(env, googleSub, refreshToken) {
  // Persist the credential first: a failed encryption/KV write must not enable Cron.
  await saveCollectorCredential(env, googleSub, refreshToken);
  await env.MCP_DB.prepare(`INSERT INTO collector_subscriptions(google_sub, enabled)
    VALUES (?, 1) ON CONFLICT(google_sub) DO UPDATE SET enabled=1,
    updated_at=CURRENT_TIMESTAMP`).bind(googleSub).run();
  return { enabled: true, time: '08:00', timezone: 'America/Los_Angeles', collectors: Object.keys(COLLECTORS) };
}

export async function disableDailyCollection(env, googleSub) {
  await env.MCP_DB.prepare('UPDATE collector_subscriptions SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE google_sub=?')
    .bind(googleSub).run();
  await deleteCollectorCredential(env, googleSub);
  return { enabled: false };
}

export async function runOneCollector({ env, googleSub, item, taskId, trigger = 'manual', now = Date.now(), refreshToken }) {
  const collector = COLLECTORS[taskId];
  if (!collector) throw new Error('Unknown collection task: ' + taskId);
  const date = localDay(now), runId = crypto.randomUUID();
  const claim = await env.MCP_DB.prepare(`INSERT OR IGNORE INTO collector_runs
    (run_id, google_sub, item_id, task_id, date, trigger_kind, status)
    VALUES (?, ?, ?, ?, ?, ?, 'running')`).bind(runId, googleSub, item.itemId, taskId, date, trigger).run();
  if ((claim.meta?.changes ?? 0) === 0) return { taskId, skipped: true, reason: 'Already scheduled today.' };
  try {
    const credential = taskId === 'cws-analytics'
      ? (refreshToken || await readCollectorCredential(env, googleSub)) : undefined;
    const result = await collector.collect({ env, googleSub, item, now, refreshToken: credential });
    await env.MCP_DB.prepare(`UPDATE collector_runs SET status='succeeded', rows_written=?,
      finished_at=CURRENT_TIMESTAMP WHERE run_id=?`).bind(result.rowsWritten, runId).run();
    return { taskId, runId, status: 'succeeded', ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Collection failed';
    await env.MCP_DB.prepare(`UPDATE collector_runs SET status='failed', error_message=?,
      finished_at=CURRENT_TIMESTAMP WHERE run_id=?`).bind(message.slice(0,500), runId).run();
    return { taskId, runId, status: 'failed', error: message };
  }
}

export async function runCollection({ env, googleSub, item, tasks = Object.keys(COLLECTORS),
  trigger = 'manual', now = Date.now(), refreshToken }) {
  const runResults = [];
  for (const taskId of tasks) {
    runResults.push(await runOneCollector({ env, googleSub, item, taskId, trigger, now, refreshToken }));
  }
  return runResults;
}

export function dueCollectorIds(scheduledTime) {
  return Object.values(COLLECTORS).filter(task => task.schedule.hourPT === localHour(scheduledTime))
    .map(task => task.id);
}

export async function handleCollectionSchedule(env, scheduledTime) {
  const dueTasks = dueCollectorIds(scheduledTime);
  if (!dueTasks.length) return { skipped: true, reason: 'No collector is due at this Pacific hour' };
  const { results } = await env.MCP_DB.prepare(`SELECT google_sub FROM collector_subscriptions
    WHERE enabled=1 ORDER BY google_sub LIMIT 100`).all();
  const allResults = [];
  for (const { google_sub: googleSub } of results ?? []) {
    const extensions = await listUserExtensions(env.MCP_DB, googleSub);
    for (const item of extensions) {
      const runs = await runCollection({ env, googleSub, item, tasks: dueTasks, trigger: 'scheduled', now: scheduledTime });
      allResults.push({ itemId: item.itemId, results: runs.map(({taskId, status, skipped, error}) =>
        ({taskId, status, skipped, error})) });
    }
  }
  return { day: localDay(scheduledTime), accountCount: results?.length ?? 0, runs: allResults };
}
