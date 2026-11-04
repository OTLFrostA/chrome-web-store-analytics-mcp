import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay, localHour, isMorningCollectionTime } from '../src/collection/time.js';
import { dueCollectorIds, handleCollectionSchedule } from '../src/collection/runner.js';
import { parseSearchResults, searchWebStore } from '../src/collection/ranking.js';
import { saveCollectorCredential, readCollectorCredential, deleteCollectorCredential } from '../src/collection/credentials.js';

const firstId = 'ldpbiafkgjlaooeplkiooljccpalpkgf';
const secondId = 'jfepajhaapfonhhfjmamediilplchakk';
const inner = JSON.stringify([[[[[[firstId, 'https://example.com/icon', 'Gemini Exporter'],
  [secondId, 'https://example.com/icon2', 'Other extension']]]]]]);
const outer = JSON.stringify([['wrb.fr', 'zTyKYc', inner, null]]);
const rpcResponse = ")]}'\n\n" + outer.length + '\n' + outer + '\n' + '1\n[]';

test('scheduled 8am Pacific is DST-safe', () => {
  assert.equal(isMorningCollectionTime(Date.UTC(2026, 10, 3, 16)), true); // PST
  assert.equal(isMorningCollectionTime(Date.UTC(2026, 6, 3, 15)), true); // PDT
  assert.equal(isMorningCollectionTime(Date.UTC(2026, 10, 3, 15)), false);
  assert.equal(isMorningCollectionTime(Date.UTC(2026, 6, 3, 16)), false);
  assert.equal(localDay(Date.UTC(2026, 10, 4, 3)), '2026-11-03');
  assert.equal(localHour(Date.UTC(2026, 10, 3, 16)), 8);
  assert.deepEqual(dueCollectorIds(Date.UTC(2026, 10, 3, 16)), ['cws-analytics', 'cws-ranking']);
  assert.deepEqual(dueCollectorIds(Date.UTC(2026, 10, 3, 15)), []);
});

test('ranking parser ignores trailing RPC frames and ranks extension rows', () => {
  assert.deepEqual(parseSearchResults(rpcResponse).map(({id,rank}) => ({id,rank})), [
    {id:firstId,rank:1}, {id:secondId,rank:2},
  ]);
  assert.throws(() => parseSearchResults('not a search response'));
});

test('ranking uses only the fixed official store origin and a POST RPC', async () => {
  const requests = [];
  const response = await searchWebStore('bulk export gemini', 'en-US', async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return new Response('<script>boq_chrome-webstore-consumerfe-ui_20261102.00_p0</script>');
    return new Response(rpcResponse);
  });
  assert.equal(response[0].id, firstId);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).hostname, 'chromewebstore.google.com');
  assert.equal(requests[1].options.method, 'POST');
  assert.match(requests[1].options.body, /f\.req=/);
});

test('encrypted scheduled credentials are bound to the Google subject', async () => {
  const kv = new Map();
  const env = {
    SCHEDULE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    OAUTH_KV: {
      async put(key, value) {kv.set(key, value)},
      async get(key, format) { const value = kv.get(key); return format === 'json' && value ? JSON.parse(value) : value; },
      async delete(key) { kv.delete(key) },
    },
  };
  await saveCollectorCredential(env, 'alice', 'secret-google-refresh-token');
  assert.equal(await readCollectorCredential(env, 'alice'), 'secret-google-refresh-token');
  assert.doesNotMatch([...kv.values()][0], /secret-google-refresh-token/);
  await assert.rejects(readCollectorCredential(env, 'bob')); 
  await deleteCollectorCredential(env, 'alice');
  await assert.rejects(readCollectorCredential(env, 'alice'));
});

test('batch metrics request preserves each metric and per-day dimension', async () => {
  const { fetchMetricBatch } = await import('../src/collection/metrics.js');
  const seen = [];
  const rows = await fetchMetricBatch('test-access-token', 'publisher', firstId,
    { dimension: null, metrics: ['installs', 'impressions'] }, 2,
    async (url, options) => {
      seen.push({ url: new URL(url), options });
      return new Response(JSON.stringify({ metricRows: [{
        date: { year: 2026, month: 11, day: 2 },
        metricValues: [{ metric: 'installs', value: '3' }, { metric: 'impressions', value: '87' }],
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  assert.deepEqual(rows.map(row => [row.metric, row.value]), [['installs', 3], ['impressions', 87]]);
  assert.deepEqual(seen[0].url.searchParams.getAll('metrics'), ['installs', 'impressions']);
  assert.equal(seen[0].options.headers.Authorization, 'Bearer test-access-token');
});

test('dispatcher does not query D1 outside registered hours', async () => {
  const result = await handleCollectionSchedule({ MCP_DB: { prepare() { throw Error('unexpected DB access'); } } }, Date.UTC(2026, 10, 3, 15));
  assert.equal(result.skipped, true);
});
