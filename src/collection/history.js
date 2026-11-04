import { localDay } from './time.js';

const METRIC_SQL = `INSERT INTO metric_history
 (google_sub, item_id, date, metric, dimension, dimension_value, value, unique_user_count)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(google_sub, item_id, date, metric, dimension, dimension_value)
 DO UPDATE SET value=excluded.value, unique_user_count=excluded.unique_user_count,
 collected_at=CURRENT_TIMESTAMP`;

export async function saveMetricHistory(db, googleSub, itemId, metricRows) {
  // Batch atomic updates without unbounded statements in one D1 call.
  for (let i = 0; i < metricRows.length; i += 60) {
    const jobs = metricRows.slice(i, i + 60).map(row => db.prepare(METRIC_SQL).bind(
      googleSub, itemId, row.date, row.metric, row.dimension || 'overall',
      row.dimensionValue ?? '', row.value, row.uniqueUserCount ?? null,
    ));
    await db.batch(jobs);
  }
  return metricRows.length;
}

export async function saveQueryMetrics(db, googleSub, response) {
  return saveMetricHistory(db, googleSub, response.itemId, response.rows.map(row => ({
    date: row.date, metric: response.metric, dimension: response.dimension,
    dimensionValue: row.dimensionValue ?? '', value: row.value,
    uniqueUserCount: row.uniqueUserCount,
  })));
}

export async function saveRankingHistory(db, googleSub, itemId, keyword, locale, results, now = Date.now()) {
  const rank = results.find(row => row.id === itemId)?.rank ?? null;
  await db.prepare(`INSERT INTO ranking_history
    (google_sub, item_id, date, keyword, locale, rank, result_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_sub, item_id, date, keyword, locale)
    DO UPDATE SET rank=excluded.rank, result_count=excluded.result_count,
    collected_at=CURRENT_TIMESTAMP`).bind(
    googleSub, itemId, localDay(now), keyword, locale, rank, results.length,
  ).run();
  return { keyword, locale, rank, resultsChecked: results.length };
}

export async function getMetricHistory(db, googleSub, itemId, metric, dimension = 'overall', days = 30) {
  const { results } = await db.prepare(`SELECT date, metric, dimension, dimension_value AS dimensionValue,
    value, unique_user_count AS uniqueUserCount FROM metric_history
    WHERE google_sub=? AND item_id=? AND metric=? AND dimension=? AND date >= date('now', ?)
    ORDER BY date DESC, dimension_value LIMIT 2000`).bind(
    googleSub, itemId, metric, dimension, '-' + days + ' days',
  ).all();
  return results ?? [];
}

export async function getRankingHistory(db, googleSub, itemId, days = 30) {
  const { results } = await db.prepare(`SELECT date, keyword, locale, rank, result_count AS resultsChecked,
    collected_at AS collectedAt FROM ranking_history
    WHERE google_sub=? AND item_id=? AND date >= date('now', ?)
    ORDER BY date DESC, keyword LIMIT 1000`).bind(
    googleSub, itemId, '-' + days + ' days',
  ).all();
  return results ?? [];
}

export async function deleteExtensionHistory(db, googleSub, itemId) {
  await db.batch([
    db.prepare('DELETE FROM metric_history WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM ranking_history WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM collector_keywords WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM google_search_keywords WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM google_search_history WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM review_collection_settings WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM review_history WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
    db.prepare('DELETE FROM collector_runs WHERE google_sub=? AND item_id=?').bind(googleSub, itemId),
  ]);
}

export async function deleteAccountHistory(db, googleSub) {
  await db.batch([
    db.prepare('DELETE FROM metric_history WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM ranking_history WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM collector_keywords WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM google_search_keywords WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM google_search_history WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM google_search_settings WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM review_collection_settings WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM review_history WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM collector_runs WHERE google_sub=?').bind(googleSub),
    db.prepare('DELETE FROM collector_subscriptions WHERE google_sub=?').bind(googleSub),
  ]);
}
