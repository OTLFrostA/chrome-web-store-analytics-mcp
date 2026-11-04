import { listUserExtensions } from '../storage.js';
import { collectMetrics } from './metrics.js';
import { searchWebStore } from './ranking.js';
import { saveRankingHistory } from './history.js';
import { readCollectorCredential, saveCollectorCredential, deleteCollectorCredential, hasBrightDataKey, readBrightDataKey } from './credentials.js';
import { submitBrightDataRankings, pollBrightDataRun, listGoogleSearchKeywords } from './brightdata.js';
import { localDay, localHour } from './time.js';

async function listRankingKeywords(db, googleSub, itemId) {
  const { results } = await db.prepare(`SELECT keyword, locale FROM collector_keywords
    WHERE google_sub=? AND item_id=? AND enabled=1 ORDER BY keyword`).bind(googleSub, itemId).all();
  return results ?? [];
}

async function collectRankings({ env, googleSub, item, now, keywords }) {
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
  'google-search-ranking': { id: 'google-search-ranking', schedule: { hourPT: 8 }, collect: submitBrightDataRankings },
});

export async function updateKeywords(db, googleSub, itemId, keywords) {
  if (!Array.isArray(keywords) || keywords.length > 20 ||
      keywords.some(x => typeof x !== 'string' || !x.trim() || x.length > 120)) {
    throw new Error('Specify between 0 and 20 non-empty keywords (max 120 characters each).');
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
  // An extension with no configured keywords has no ranking work to run.
  // Check before inserting a run so a later configuration can still collect today.
  const keywords = taskId === 'cws-ranking'
    ? await listRankingKeywords(env.MCP_DB, googleSub, item.itemId) : undefined;
  if (taskId === 'cws-ranking' && keywords.length === 0) {
    return { taskId, skipped: true, reason: 'No ranking keywords configured.' };
  }
  const googleKeywords = taskId === 'google-search-ranking'
    ? await listGoogleSearchKeywords(env.MCP_DB, googleSub, item.itemId) : undefined;
  if (taskId === 'google-search-ranking' && googleKeywords.length === 0) {
    return { taskId, skipped: true, reason: 'No Google Search keywords configured.' };
  }
  if (taskId === 'google-search-ranking' && !(await hasBrightDataKey(env, googleSub))) {
    return { taskId, skipped: true, reason: 'No user-owned Bright Data key configured.' };
  }
  const date = localDay(now), runId = crypto.randomUUID();
  const claim = await env.MCP_DB.prepare(`INSERT OR IGNORE INTO collector_runs
    (run_id, google_sub, item_id, task_id, date, trigger_kind, status)
    VALUES (?, ?, ?, ?, ?, ?, 'running')`).bind(runId, googleSub, item.itemId, taskId, date, trigger).run();
  if ((claim.meta?.changes ?? 0) === 0) return { taskId, skipped: true, reason: 'Already scheduled today.' };
  try {
    const credential = taskId === 'cws-analytics'
      ? (refreshToken || await readCollectorCredential(env, googleSub)) : undefined;
    const apiKey = taskId === 'google-search-ranking' ? await readBrightDataKey(env, googleSub) : undefined;
    const result = await collector.collect({
      env, googleSub, item, now, runId, refreshToken: credential,
      keywords: taskId === 'google-search-ranking' ? googleKeywords : keywords, apiKey,
    });
    if (result.status === 'pending') {
      // Snapshot ID is stored only in account-bound KV; the D1 run stays running.
      return { taskId, runId, ...result };
    }
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


// Resume async Bright Data jobs independently of new daily submissions.
// A snapshot is fetched only with the API key belonging to its Google account.
export async function pollPendingBrightDataRankings({env, googleSub, itemId, limit = 30, request = fetch}) {
  const clauses = ["task_id='google-search-ranking'", "status='running'"];
  const values = [];
  if (googleSub) { clauses.push('google_sub=?'); values.push(googleSub); }
  if (itemId) { clauses.push('item_id=?'); values.push(itemId); }
  const {results} = await env.MCP_DB.prepare('SELECT run_id AS runId,google_sub AS googleSub,' +
    'item_id AS itemId FROM collector_runs WHERE ' + clauses.join(' AND ') +
    ' ORDER BY started_at LIMIT ?').bind(...values,limit).all();
  const runs = [];
  for (const job of results ?? []) {
    try {
      const key = await readBrightDataKey(env,job.googleSub);
      if (!key) {
        runs.push({runId:job.runId,status:'pending',reason:'User Bright Data key is not configured.'});
        continue;
      }
      runs.push(await pollBrightDataRun({env,googleSub:job.googleSub,
        itemId:job.itemId,runId:job.runId,apiKey:key,request}));
    } catch {
      // Do not leak response bodies or credentials into logs/tool outputs.
      runs.push({runId:job.runId,status:'pending',reason:'Snapshot polling failed.'});
    }
  }
  return runs;
}

export function dueCollectorIds(scheduledTime) {
  return Object.values(COLLECTORS).filter(task => task.schedule.hourPT === localHour(scheduledTime))
    .map(task => task.id);
}

export async function handleCollectionSchedule(env, scheduledTime) {
  // The hourly cron polls already-paid async snapshots even outside 8 AM Pacific.
  const pending = await pollPendingBrightDataRankings({env});
  const dueTasks = dueCollectorIds(scheduledTime);
  if (!dueTasks.length) return { skipped: true, reason: 'No new collector is due at this Pacific hour', pending };
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
  return { day: localDay(scheduledTime), accountCount: results?.length ?? 0, runs: allResults, pending };
}
