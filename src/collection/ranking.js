const STORE = 'https://chromewebstore.google.com';
const RPC_PATH = '/_/ChromeWebStoreConsumerFeUi/data/batchexecute';
const SEARCH_RPC_ID = 'zTyKYc'; // Unofficial Web Store RPC; monitor for breakage.

export function parseSearchResults(raw) {
  const first = raw.indexOf('[[');
  if (first < 0) throw new Error('Search response did not contain an RPC frame.');
  // batchexecute is length-prefixed and may have trailing control frames.
  const frame = JSON.parse(raw.slice(first).split('\n')[0]);
  const payload = frame.find(row => Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === SEARCH_RPC_ID)?.[2];
  if (typeof payload !== 'string') throw new Error('Search RPC payload is missing.');
  const data = JSON.parse(payload), seen = new Set(), extensions = [];
  function walk(node) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string' && /^[a-p]{32}$/.test(node[0]) &&
        typeof node[2] === 'string' && !seen.has(node[0])) {
      seen.add(node[0]);
      extensions.push({ id: node[0], title: node[2], rank: extensions.length + 1 });
    }
    for (const child of node) walk(child);
  }
  walk(data);
  if (extensions.length === 0) throw new Error('Search response had no recognizable extension rows.');
  return extensions;
}

export async function searchWebStore(keyword, locale = 'en-US', request = fetch) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 120) {
    throw new Error('Invalid keyword.');
  }
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new Error('Invalid locale.');
  const searchPath = '/search/' + encodeURIComponent(keyword.trim());
  const page = await request(STORE + searchPath, {
    headers: { 'Accept-Language': locale + ',en;q=0.9' },
  });
  if (!page.ok) throw new Error('Search page request failed (HTTP ' + page.status + ').');
  const html = await page.text();
  const build = html.match(/boq_chrome-webstore-consumerfe-ui_[0-9]{8}\.[0-9]{2}_p[0-9]+/)?.[0];
  if (!build) throw new Error('Chrome Web Store search build identifier is missing.');
  const query = new URLSearchParams({
    rpcids: SEARCH_RPC_ID, 'source-path': '/search', bl: build, hl: locale,
    'soc-app': '1', 'soc-platform': '1', 'soc-device': '1', rt: 'c',
  });
  const args = [[null, [null, null, null, [keyword, [50], null, ['EXTENSION'],
    null, null, null, null, 1]]]];
  const requestBody = JSON.stringify([[[SEARCH_RPC_ID, JSON.stringify(args), null, '3']]]);
  const response = await request(STORE + RPC_PATH + '?' + query, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: '*/*', Origin: STORE, Referer: STORE + searchPath,
    },
    body: new URLSearchParams({ 'f.req': requestBody }).toString(),
  });
  if (!response.ok) throw new Error('Search RPC request failed (HTTP ' + response.status + ').');
  return parseSearchResults(await response.text());
}
