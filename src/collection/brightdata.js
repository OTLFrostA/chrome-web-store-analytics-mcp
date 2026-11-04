// Account-scoped Google organic ranking via Bright Data's async "Google SERP - 100 Results" dataset.
// Each connected Google user supplies their own API key; no shared credentials or default keywords.
import { localDay } from './time.js';

const ORIGIN = 'https://api.brightdata.com';
const DATASET_ID = 'gd_mfz5x93lmsjjjylob';
const JOB_PREFIX = 'brightdata-job:v1:';
const DEFAULT_MONTHLY_LIMIT = 200;
const MAX_KEYWORDS = 100;
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;
// Bright Data now issues both s_* and sd_* dataset snapshot IDs.
const SNAPSHOT_ID = /^s(?:d)?_[a-zA-Z0-9_-]{5,128}$/;

function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? (year + 1) + '-01-01' :
    year + '-' + String(m + 1).padStart(2, '0') + '-01';
}

function apiHeaders(apiKey, json = false) {
  return {
    Authorization: 'Bearer ' + apiKey,
    ...(json ? {'Content-Type': 'application/json'} : {}),
  };
}

// Classify vendor errors without ever logging or returning the raw response body,
// which may contain a private API key or account identifiers.
export async function sanitizedHttpError(response) {
  const prefix = 'http_' + response.status;
  if (response.status !== 400) return new Error(prefix);
  let body = '';
  try { body = (await response.text()).slice(0,4096).toLowerCase(); } catch { return new Error(prefix); }
  let reason = null;
  if (/permission|unauthoriz|not permitted|access denied|not allowed for (this |the )?account/.test(body))
    reason = 'access_denied';
  else if (/funds|balance|billing|credit|payment/.test(body))
    reason = 'billing';
  else if (/scraper.*(inactive|disabled)|not activated/.test(body))
    reason = 'scraper_disabled';
  else if (/dataset.*(not found|does not exist|invalid)/.test(body))
    reason = 'dataset_unavailable';
  else if (/validat|input|invalid|unsupported|unrecognized|should not contain|unexpected field/.test(body)) {
    const field = ['country','start_page','end_page','language','keyword','url','dataset_id','format']
      .find(name => new RegExp('(?:[^a-z_]|^)' + name + '(?:[^a-z_]|$)').test(body));
    reason = field ? 'invalid_' + field : 'input_validation';
  }
  return new Error(prefix + (reason ? '_' + reason : ''));
}

export async function verifyBrightDataKey(apiKey, request = fetch) {
  // Read-only zone enumeration checks the token without running billable searches.
  // See Bright Data's SDK authentication troubleshooting for this endpoint.
  const response = await request(ORIGIN + '/zone/get_active_zones', {
    headers: apiHeaders(apiKey), redirect: 'manual',
  });
  if (!response.ok) throw new Error('Bright Data token verification failed (HTTP ' + response.status + ').');
  // Never return the account's zone names, balances, token or user details.
  return { verified: true };
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

export async function setGoogleSearchMonthlyLimit(db, googleSub, monthlyLimit) {
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 5000) {
    throw new Error('Bright Data monthly budget must be between 1 and 5,000 keyword records.');
  }
  await db.prepare('INSERT INTO google_search_settings (google_sub,monthly_limit) VALUES (?,?) ' +
    'ON CONFLICT(google_sub) DO UPDATE SET monthly_limit=excluded.monthly_limit,updated_at=CURRENT_TIMESTAMP')
    .bind(googleSub, monthlyLimit).run();
  return { monthlyLimit };
}

export async function updateGoogleSearchKeywords(db, googleSub, itemId, keywords) {
  if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS ||
      keywords.some(value => typeof value !== 'string' || !value.trim() || value.length > 120)) {
    throw new Error('Provide 0 to 100 non-empty Google search phrases (up to 120 characters each).');
  }
  const normalized = [...new Map(keywords.map(word =>
    [word.trim().toLowerCase(), word.trim()])).values()];
  await db.batch([
    db.prepare('DELETE FROM google_search_keywords WHERE google_sub=? AND item_id=?')
      .bind(googleSub, itemId),
    ...normalized.map(word => db.prepare('INSERT INTO google_search_keywords ' +
      "(google_sub,item_id,keyword,market,device) VALUES (?,?,?,'us/en','desktop')")
      .bind(googleSub, itemId, word)),
  ]);
  return normalized;
}

export async function listGoogleSearchKeywords(db, googleSub, itemId) {
  const response = await db.prepare('SELECT keyword,market,device FROM google_search_keywords ' +
    'WHERE google_sub=? AND item_id=? AND enabled=1 ORDER BY keyword')
    .bind(googleSub, itemId).all();
  return response.results ?? [];
}

export async function getGoogleSearchHistory(db, googleSub, itemId, days = 30) {
  const response = await db.prepare('SELECT date,keyword,market,device,status,rank,' +
    'result_url AS resultUrl,result_title AS resultTitle,' +
    'result_count AS resultsChecked,error_code AS errorCode,checked_at AS checkedAt ' +
    "FROM google_search_history WHERE google_sub=? AND item_id=? AND date >= date('now',?) " +
    'ORDER BY date DESC,keyword LIMIT 1000')
    .bind(googleSub, itemId, '-' + days + ' days').all();
  return response.results ?? [];
}

const RESERVE = 'INSERT INTO google_search_history ' +
  '(google_sub,item_id,date,keyword,market,device,status) ' +
  "SELECT ?,?,?,?,?,?,'pending' WHERE (SELECT COUNT(*) FROM google_search_history " +
  'WHERE google_sub=? AND date >= ? AND date < ?) < ? ON CONFLICT DO NOTHING';

const FINISH = 'UPDATE google_search_history SET status=?,rank=?,result_url=?,result_title=?,' +
  'result_count=?,error_code=?,checked_at=CURRENT_TIMESTAMP ' +
  'WHERE google_sub=? AND item_id=? AND date=? AND keyword=? AND market=? AND device=? ' +
  "AND status='pending'";

function finishRow(db, googleSub, itemId, date, entry, {status, rank = null,
  url = null, title = null, resultCount = null, errorCode = null}) {
  return db.prepare(FINISH).bind(status,rank,url,title,resultCount,errorCode,
    googleSub,itemId,date,entry.keyword,entry.market,entry.device).run();
}

function searchInput({keyword}) {
  return {url:'https://www.google.com/', keyword, language:'en', country:'US',
    start_page:1, end_page:10};
}


export function parseSnapshotId(payload) {
  const snapshotId = payload?.snapshot_id;
  if (typeof snapshotId !== 'string') {
    if (payload?.error || payload?.errors) throw new Error('provider_reported_error');
    throw new Error('missing_snapshot_id');
  }
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error('invalid_snapshot_id');
  return snapshotId;
}

export async function submitBrightDataRankings({
  env, googleSub, item, runId, now = Date.now(), keywords, apiKey, request = fetch,
}) {
  if (!apiKey || !runId || !Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('Bright Data key, collector run ID and keywords are required.');
  }
  const date = localDay(now);
  const from = date.slice(0, 7) + '-01', until = nextMonth(date.slice(0, 7));
  const {monthlyLimit} = await getGoogleSearchBudget(env.MCP_DB, googleSub, now);
  const selected = [];
  let skipped = 0;
  for (const entry of keywords) {
    const record = {keyword:entry.keyword,market:entry.market || 'us/en',
      device:entry.device || 'desktop'};
    const reserved = await env.MCP_DB.prepare(RESERVE).bind(
      googleSub,item.itemId,date,record.keyword,record.market,record.device,
      googleSub,from,until,monthlyLimit).run();
    if (Number(reserved.meta?.changes ?? 0) > 0) selected.push(record);
    else skipped++;
  }
  const quotaReached = selected.length < keywords.length;
  if (selected.length === 0) {
    return {status:'succeeded',rowsWritten:0,requested:0,skipped,quotaReached};
  }
  try {
    const response = await request(ORIGIN +
      '/datasets/v3/trigger?dataset_id=' + DATASET_ID + '&include_errors=true', {
      method:'POST',redirect:'manual',headers:apiHeaders(apiKey,true),
      body:JSON.stringify(selected.map(searchInput)),
    });
    if (!response.ok) throw await sanitizedHttpError(response);
    let payload;
    try {payload = await response.json();} catch {throw new Error('invalid_json');}
    const snapshotId = parseSnapshotId(payload);
    // KV stores only the opaque ID and keyword metadata, never the API key.
    await env.OAUTH_KV.put(JOB_PREFIX + runId, JSON.stringify({
      snapshotId,googleSub,itemId:item.itemId,date,keywords:selected,
    }),{expirationTtl:JOB_TTL_SECONDS});
    return {status:'pending',rowsWritten:0,requested:selected.length,skipped,quotaReached};
  } catch (error) {
    const code = error instanceof Error && /^(http_[0-9]{3}(?:_[a-z_]{3,48})?|invalid_json|missing_snapshot_id|invalid_snapshot_id|provider_reported_error)$/.test(error.message)
      ? error.message : 'request_failed';
    for (const entry of selected) {
      await finishRow(env.MCP_DB,googleSub,item.itemId,date,entry,{status:'error',errorCode:code});
    }
    throw new Error('Bright Data request failed (' + code + ').');
  }
}

// Only trusted Chrome Web Store details (including Google-owned redirect wrappers) count.
// Never fetch or follow a third-party link merely to test a ranking.
export function isTargetStoreUrl(raw, itemId) {
  if (typeof raw !== 'string' || !/^[a-p]{32}$/.test(itemId)) return false;
  try {
    let url = new URL(raw);
    for (let i = 0; i < 2; i++) {
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      if (['chromewebstore.google.com','chrome.google.com'].includes(url.hostname)) {
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.includes('detail') && parts.at(-1) === itemId;
      }
      if (!['www.google.com','google.com'].includes(url.hostname) ||
          !['/url','/goto'].includes(url.pathname)) return false;
      const destination = ['url','q','target'].map(key=>url.searchParams.get(key))
        .find(value=>typeof value==='string' && value.startsWith('https://'));
      if (!destination) return false;
      url = new URL(destination);
    }
  } catch {return false;}
  return false;
}

function organicItems(record) {
  if (!record || typeof record !== 'object') return null;
  if (Array.isArray(record.organic)) return record.organic;
  if (Array.isArray(record.organic_results)) return record.organic_results;
  if (Array.isArray(record.results?.organic)) return record.results.organic;
  return null;
}

export function findGoogleStoreRank(organicResults, itemId) {
  for (let i = 0; i < organicResults.length; i++) {
    const row = organicResults[i];
    const link = row?.link ?? row?.url;
    if (!isTargetStoreUrl(link,itemId)) continue;
    const num = Number(row.global_rank ?? row.position ?? row.rank);
    // Some datasets restart their local rank at 1 on each Google results page.
    const rank = Number.isInteger(num) && num > 0 && num <= 100 &&
      (organicResults.length <= 10 || num >= i + 1) ? num : i + 1;
    return {rank,url:link,title:typeof row.title==='string'?row.title.slice(0,500):null};
  }
  return null;
}

function snapshotRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return null;
}

function rowKeyword(record) {
  const term = record?.keyword ?? record?.input?.keyword ?? record?.general?.query ??
    record?.query ?? record?.search_query;
  return typeof term === 'string' ? term.trim().toLowerCase() : null;
}

export function parseBrightDataSnapshot(payload, keywords, itemId) {
  const records = snapshotRecords(payload);
  if (!records) throw new Error('invalid_snapshot_shape');
  const byKeyword = new Map();
  for (const row of records) {
    const term = rowKeyword(row);
    if (term && !byKeyword.has(term)) byKeyword.set(term,row);
  }
  return keywords.map(entry => {
    const record = byKeyword.get(entry.keyword.toLowerCase());
    if (!record) return {entry,status:'error',errorCode:'keyword_missing'};
    if (record.error || record.status === 'error') {
      return {entry,status:'error',errorCode:'provider_error'};
    }
    const organic = organicItems(record);
    if (!organic || organic.length === 0) {
      return {entry,status:'error',errorCode:'missing_organic_results'};
    }
    const match = findGoogleStoreRank(organic,itemId);
    return {entry,status:match?'found':'not_found',rank:match?.rank ?? null,
      url:match?.url ?? null,title:match?.title ?? null,resultCount:organic.length};
  });
}

export async function pollBrightDataRun({env,googleSub,itemId,runId,apiKey,request=fetch}) {
  const job = await env.OAUTH_KV.get(JOB_PREFIX + runId,'json');
  if (!job) return {runId,status:'pending',reason:'Snapshot metadata is not available yet.'};
  if (job.googleSub!==googleSub || job.itemId!==itemId ||
      !Array.isArray(job.keywords) || !SNAPSHOT_ID.test(job.snapshotId)) {
    throw new Error('Invalid account-bound Bright Data snapshot metadata.');
  }
  const headers = apiHeaders(apiKey);
  const progress = await request(ORIGIN + '/datasets/v3/progress/' + job.snapshotId,
    {headers,redirect:'manual'});
  if (!progress.ok) return {runId,status:'pending',reason:'Progress check failed (HTTP ' +
    progress.status + ').'};
  let state;
  try {state = await progress.json();} catch {return {runId,status:'pending',reason:'Invalid progress response.'};}
  if (state.status === 'starting' || state.status === 'running') {
    return {runId,status:'pending',reason:'Dataset still processing.'};
  }
  let results;
  if (state.status === 'ready') {
    const download = await request(ORIGIN + '/datasets/v3/snapshot/' +
      job.snapshotId + '?format=json', {headers,redirect:'manual'});
    if (!download.ok) return {runId,status:'pending',reason:'Snapshot not downloadable yet.'};
    let payload;
    try {payload = await download.json();} catch {
      return {runId,status:'pending',reason:'Snapshot JSON not ready.'};
    }
    try {results = parseBrightDataSnapshot(payload,job.keywords,itemId);}
    catch {results=job.keywords.map(entry=>({entry,status:'error',errorCode:'invalid_snapshot_shape'}));}
  } else if (state.status === 'failed') {
    results=job.keywords.map(entry=>({entry,status:'error',errorCode:'provider_failed'}));
  } else return {runId,status:'pending',reason:'Provider status unknown.'};
  let written=0,found=0,failed=0;
  for (const row of results) {
    const result = await finishRow(env.MCP_DB,googleSub,itemId,job.date,row.entry,row);
    written += Number(result.meta?.changes ?? 0);
    if (row.status==='found') found++;
    if (row.status==='error') failed++;
  }
  const status = failed?'failed':'succeeded';
  await env.MCP_DB.prepare('UPDATE collector_runs SET status=?,rows_written=?,error_message=?,' +
    'finished_at=CURRENT_TIMESTAMP WHERE run_id=? AND google_sub=? AND item_id=? AND status=?')
    .bind(status,written,failed?'Bright Data returned incomplete or failed results.':null,
      runId,googleSub,itemId,'running').run();
  await env.OAUTH_KV.delete(JOB_PREFIX + runId);
  return {runId,status,rowsWritten:written,found,failed};
}
