// Google organic results via SerpAPI, separate from Chrome Web Store internal search.
// SerpAPI is BYOK: credentials are supplied by each authenticated Google user,
// stored encrypted in KV, and never hard-coded or returned in responses.
import { localDay } from './time.js';

const SERPAPI_ORIGIN = 'https://serpapi.com';
const DEFAULT_MONTHLY_LIMIT = 200;
const MARKET = 'us/en';
const DEVICE = 'desktop';

export function isTargetStoreUrl(value, itemId) {
  if (typeof value !== 'string' || !/^[a-p]{32}$/.test(itemId)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['chromewebstore.google.com', 'chrome.google.com'].includes(url.hostname)) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.includes('detail') && parts.at(-1) === itemId;
  } catch {
    return false;
  }
}

export function findGoogleStoreRank(organicResults, itemId) {
  for (let i = 0; i < organicResults.length; i++) {
    const row = organicResults[i];
    if (!isTargetStoreUrl(row?.link, itemId)) continue;
    const position = Number(row.position);
    return {
      rank: Number.isInteger(position) && position > 0 ? position : i + 1,
      url: row.link,
      title: typeof row.title === 'string' ? row.title.slice(0, 500) : null,
    };
  }
  return null;
}

function serpApiUrl(apiKey, endpoint, params = {}) {
  const url = new URL(endpoint, SERPAPI_ORIGIN);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}

export async function verifySerpApiKey(apiKey, request = fetch) {
  // Account API does not consume a search credit. Only allowlisted fields are
  // returned: its response includes the plaintext api_key and user email.
  const response = await request(serpApiUrl(apiKey, '/account.json'), { redirect: 'error' });
  if (!response.ok) throw new Error('SerpAPI key verification failed (HTTP ' + response.status + ').');
  let data;
  try { data = await response.json(); } catch { throw new Error('SerpAPI account API returned invalid JSON.'); }
  if (data?.error || typeof data !== 'object' || data === null ||
      typeof data.account_id !== 'string') {
    throw new Error('SerpAPI account verification failed.');
  }
  return {
    plan: typeof data.plan_name === 'string' ? data.plan_name.slice(0, 100) : null,
    searchesPerMonth: Number.isFinite(data.searches_per_month) ? data.searches_per_month : null,
    searchesLeft: Number.isFinite(data.total_searches_left) ? data.total_searches_left : null,
  };
}

export async function getGoogleSearchBudget(db, googleSub, now = Date.now()) {
  const month = localDay(now).slice(0, 7);
  const [config, spent] = await Promise.all([
    db.prepare('SELECT monthly_limit AS monthlyLimit FROM google_search_settings WHERE google_sub=?')
      .bind(googleSub).first(),
    db.prepare('SELECT COUNT(*) AS n FROM google_search_history WHERE google_sub=? AND date >= ? AND date < ?')
      .bind(googleSub, month + '-01', nextMonth(month)).first(),
  ]);
  return {
    monthlyLimit: config?.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT,
    requestedThisMonth: spent?.n ?? 0,
    month,
  };
}

function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? (year + 1) + '-01-01' : year + '-' + String(m + 1).padStart(2, '0') + '-01';
}

export async function setGoogleSearchMonthlyLimit(db, googleSub, monthlyLimit) {
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 100000) {
    throw new Error('Monthly SerpAPI request limit must be an integer from 1 to 100000.');
  }
  await db.prepare(`INSERT INTO google_search_settings (google_sub,monthly_limit)
    VALUES (?,?) ON CONFLICT(google_sub) DO UPDATE SET
    monthly_limit=excluded.monthly_limit,updated_at=CURRENT_TIMESTAMP`)
    .bind(googleSub, monthlyLimit).run();
  return { monthlyLimit };
}

export async function updateGoogleSearchKeywords(db, googleSub, itemId, keywords) {
  if (!Array.isArray(keywords) || keywords.length > 20 ||
      keywords.some(value => typeof value !== 'string' || !value.trim() || value.length > 120)) {
    throw new Error('Provide 0 to 20 non-empty Google search phrases (up to 120 characters each).');
  }
  const normalized = [...new Map(keywords.map(word => [word.trim().toLowerCase(), word.trim()])).values()];
  await db.batch([
    db.prepare('DELETE FROM google_search_keywords WHERE google_sub=? AND item_id=?')
      .bind(googleSub, itemId),
    ...normalized.map(word => db.prepare(`INSERT INTO google_search_keywords
      (google_sub,item_id,keyword,market,device) VALUES (?,?,?,'us/en','desktop')`)
      .bind(googleSub, itemId, word)),
  ]);
  return normalized;
}

export async function listGoogleSearchKeywords(db, googleSub, itemId) {
  const response = await db.prepare(`SELECT keyword,market,device
    FROM google_search_keywords WHERE google_sub=? AND item_id=? AND enabled=1
    ORDER BY keyword`).bind(googleSub, itemId).all();
  return response.results ?? [];
}

export async function getGoogleSearchHistory(db, googleSub, itemId, days = 30) {
  const response = await db.prepare(`SELECT date,keyword,market,device,status,rank,
    result_url AS resultUrl,result_title AS resultTitle,
    result_count AS resultsChecked,error_code AS errorCode,checked_at AS checkedAt
    FROM google_search_history WHERE google_sub=? AND item_id=? AND date >= date('now',?)
    ORDER BY date DESC,keyword LIMIT 1000`)
    .bind(googleSub, itemId, '-' + days + ' days').all();
  return response.results ?? [];
}

const RESERVE = `INSERT INTO google_search_history
  (google_sub,item_id,date,keyword,market,device,status)
  SELECT ?,?,?,?,?,?,'pending'
  WHERE (SELECT COUNT(*) FROM google_search_history
         WHERE google_sub=? AND date >= ? AND date < ?) < ?
  ON CONFLICT DO NOTHING`;

const FINISH = `UPDATE google_search_history SET status=?,rank=?,result_url=?,result_title=?,
  result_count=?,error_code=?,checked_at=CURRENT_TIMESTAMP
  WHERE google_sub=? AND item_id=? AND date=? AND keyword=? AND market=? AND device=? AND status='pending'`;

export async function collectGoogleSearchRankings({
  env, googleSub, item, now = Date.now(), keywords, apiKey, request = fetch,
}) {
  if (!apiKey || !Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('Missing user SerpAPI credential or keywords.');
  }
  const date = localDay(now);
  const from = date.slice(0, 7) + '-01';
  const until = nextMonth(date.slice(0, 7));
  const { monthlyLimit, requestedThisMonth } = await getGoogleSearchBudget(env.MCP_DB, googleSub, now);
  let queried = 0, skipped = 0, found = 0, failed = 0, quotaReached = false;
  for (const entry of keywords) {
    const { keyword, market = MARKET, device = DEVICE } = entry;
    const reserved = await env.MCP_DB.prepare(RESERVE).bind(
      googleSub,item.itemId,date,keyword,market,device,
      googleSub,from,until,monthlyLimit,
    ).run();
    if (Number(reserved.meta?.changes ?? 0) === 0) {
      // Includes already-queried keywords and an exhausted monthly budget.
      skipped++;
      if (requestedThisMonth + queried >= monthlyLimit) quotaReached = true;
      continue;
    }
    queried++;
    let status = 'error', rank = null, resultUrl = null, resultTitle = null,
      resultCount = null, errorCode = null, stop = false;
    try {
      const url = serpApiUrl(apiKey, '/search.json', {
        engine: 'google', q: keyword, gl: 'us', hl: 'en',
        google_domain: 'google.com', device, num: 100,
      });
      const response = await request(url, { redirect: 'error' });
      if (!response.ok) {
        stop = response.status === 429 || response.status === 401 || response.status === 403;
        throw new Error('http_' + response.status);
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error('invalid_json'); }
      if (payload?.error) throw new Error('api_error');
      if (payload?.search_metadata?.status && payload.search_metadata.status !== 'Success') {
        throw new Error('search_incomplete');
      }
      if (!Array.isArray(payload?.organic_results)) throw new Error('missing_organic_results');
      resultCount = payload.organic_results.length;
      const match = findGoogleStoreRank(payload.organic_results, item.itemId);
      if (match) {
        status = 'found'; rank = match.rank;
        resultUrl = match.url; resultTitle = match.title; found++;
      } else status = 'not_found';
    } catch (error) {
      failed++;
      errorCode = error instanceof Error && /^(http_[0-9]{3}|api_error|invalid_json|missing_organic_results|search_incomplete)$/.test(error.message)
        ? error.message : 'request_failed';
    }
    await env.MCP_DB.prepare(FINISH).bind(
      status,rank,resultUrl,resultTitle,resultCount,errorCode,
      googleSub,item.itemId,date,keyword,market,device,
    ).run();
    if (stop) break;
  }
  if (failed) throw new Error('Google search ranking failed for ' + failed +
    ' keyword(s); see saved history for redacted error codes.');
  return { rowsWritten: queried, queried, skipped, found, quotaReached };
}
