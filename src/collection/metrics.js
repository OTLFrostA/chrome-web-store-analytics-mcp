import { JOBS } from '../jobs.js';
import { addDate } from '../dates.js';
import { dateRange } from '../validation.js';
import { refreshGoogleAccessToken } from '../google.js';
import { googleFetch } from '../rate-limit.js';
import { saveMetricHistory } from './history.js';

export async function fetchMetricBatch(token, publisherId, itemId, job, days, request = fetch) {
  const { from, to } = dateRange(days);
  const results = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://chromewebstore.googleapis.com/v2/publishers/' +
      encodeURIComponent(publisherId) + '/items/' + encodeURIComponent(itemId) + ':queryMetrics');
    for (const metric of job.metrics) url.searchParams.append('metrics', metric);
    if (job.dimension) url.searchParams.set('dimensions', job.dimension);
    addDate(url, 'timeSpec.firstDate', from);
    addDate(url, 'timeSpec.lastDate', to);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await request(url.toString(), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Scheduled Google metrics request failed (HTTP ' + response.status + ').');
    const data = await response.json();
    if (!Array.isArray(data.metricRows ?? [])) throw new Error('Invalid Google metrics response.');
    for (const row of data.metricRows ?? []) {
      if (!row.date || !Array.isArray(row.metricValues)) continue;
      const date = String(row.date.year) + '-' + String(row.date.month).padStart(2, '0') + '-' +
        String(row.date.day).padStart(2, '0');
      const valueDimension = job.dimension ? (row.dimensionValues?.[0] ?? '') : '';
      const dimensionValue = typeof valueDimension === 'string' ? valueDimension : JSON.stringify(valueDimension);
      for (const value of row.metricValues) {
        if (!job.metrics.includes(value.metric)) continue;
        const amount = Number(value.value);
        if (!Number.isFinite(amount)) throw new Error('Invalid Google metric value.');
        results.push({
          date, metric: value.metric, dimension: job.dimension || 'overall', dimensionValue,
          value: amount,
          ...(value.uniqueUserCount === undefined ? {} : { uniqueUserCount: Number(value.uniqueUserCount) }),
        });
      }
    }
    if (!data.nextPageToken) return results;
    pageToken = data.nextPageToken;
  }
  throw new Error('Too many Google metrics pages.');
}

export async function collectMetrics({ env, googleSub, item, refreshToken }) {
  // Pace Google API calls: the existing per-account rate limiter allows only
  // 20 requests per minute, while a full breakdown backfill may paginate.
  // The 3.2s spacing makes daily Cron runs reliable without bypassing the limiter.
  const checkedRequest = googleFetch(env.GOOGLE_API_RATE_LIMITER, googleSub);
  let nextRequestAt = 0;
  const request = async (url, options) => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + 3200;
    return checkedRequest(url, options);
  };
  const token = await refreshGoogleAccessToken(env, refreshToken, request);
  const success = await env.MCP_DB.prepare(`SELECT 1 FROM collector_runs WHERE google_sub=? AND item_id=?
    AND task_id='cws-analytics' AND status='succeeded' LIMIT 1`).bind(googleSub, item.itemId).first();
  const days = success ? 14 : 90;
  let written = 0;
  for (const job of JOBS) {
    const rows = await fetchMetricBatch(token, item.publisherId, item.itemId, job, days, request);
    written += await saveMetricHistory(env.MCP_DB, googleSub, item.itemId, rows);
  }
  return { rowsWritten: written, daysRequested: days, jobsExecuted: JOBS.length };
}
