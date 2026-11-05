import { localDay } from "./time.js";

const MAX_JSON_BYTES = 1_500_000;

function boundedJson(value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).length > MAX_JSON_BYTES) {
    throw new Error("External query response is too large for D1; it was not marked as persisted.");
  }
  return serialized;
}

export async function saveRatingSnapshot(db, googleSub, itemId, summary, now = Date.now()) {
  const date = localDay(now);
  await db.prepare(`INSERT INTO rating_history (google_sub,item_id,date,summary_json)
    VALUES (?,?,?,?) ON CONFLICT(google_sub,item_id,date)
    DO UPDATE SET summary_json=excluded.summary_json,collected_at=CURRENT_TIMESTAMP`)
    .bind(googleSub,itemId,date,boundedJson(summary)).run();
  return { date, saved: true };
}

export async function saveStatusEvent(db, googleSub, itemId, status) {
  const payload = boundedJson(status);
  const prior = await db.prepare(`SELECT status_json AS statusJson FROM extension_status_events
    WHERE google_sub=? AND item_id=? ORDER BY id DESC LIMIT 1`)
    .bind(googleSub,itemId).first();
  if (prior?.statusJson === payload) return { changed: false, saved: true };
  await db.prepare(`INSERT INTO extension_status_events
    (google_sub,item_id,status_json) VALUES (?,?,?)`)
    .bind(googleSub,itemId,payload).run();
  return { changed: true, saved: true };
}

export async function saveWebStoreSearchSnapshot(db, googleSub, itemId,
  keyword, locale, results, now = Date.now()) {
  const date = localDay(now);
  await db.prepare(`INSERT INTO webstore_search_snapshots
    (google_sub,item_id,date,keyword,locale,results_json)
    VALUES (?,?,?,?,?,?) ON CONFLICT(google_sub,item_id,date,keyword,locale)
    DO UPDATE SET results_json=excluded.results_json,collected_at=CURRENT_TIMESTAMP`)
    .bind(googleSub,itemId,date,keyword,locale,boundedJson(results)).run();
  return { date, saved: true };
}

// One full Bright Data record per keyword. Upsert is safe when a pending
// snapshot is retried after an intermediate D1 or provider failure.
export async function saveGoogleSearchSnapshots(db, googleSub, itemId, date,
  snapshotId, records) {
  if (!records.length) return 0;
  const sql = `INSERT INTO google_search_snapshots
    (google_sub,item_id,date,keyword,market,device,snapshot_id,payload_json)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(google_sub,item_id,date,keyword,market,device)
    DO UPDATE SET snapshot_id=excluded.snapshot_id,payload_json=excluded.payload_json,
    collected_at=CURRENT_TIMESTAMP`;
  const statements = records.map(({keyword,market,device,payload}) =>
    db.prepare(sql).bind(googleSub,itemId,date,keyword,market,device,
      snapshotId,boundedJson(payload)));
  for (let i = 0; i < statements.length; i += 40) {
    await db.batch(statements.slice(i,i+40));
  }
  return records.length;
}

export async function getRatingHistory(db, googleSub, itemId, days = 90) {
  const {results} = await db.prepare(`SELECT date,summary_json AS summaryJson,collected_at AS collectedAt
    FROM rating_history WHERE google_sub=? AND item_id=? AND date >= date('now',?)
    ORDER BY date DESC LIMIT 365`).bind(googleSub,itemId,'-'+days+' days').all();
  return (results??[]).map(({summaryJson,...row})=>({...row,summary:JSON.parse(summaryJson)}));
}

export async function getStatusEvents(db, googleSub, itemId, limit = 100) {
  const {results} = await db.prepare(`SELECT id,observed_at AS observedAt,status_json AS statusJson
    FROM extension_status_events WHERE google_sub=? AND item_id=?
    ORDER BY id DESC LIMIT ?`).bind(googleSub,itemId,limit).all();
  return (results??[]).map(({statusJson,...row})=>({...row,status:JSON.parse(statusJson)}));
}

export async function getWebStoreSearchSnapshots(db, googleSub, itemId, days = 30) {
  const {results} = await db.prepare(`SELECT date,keyword,locale,results_json AS resultsJson,
    collected_at AS collectedAt FROM webstore_search_snapshots
    WHERE google_sub=? AND item_id=? AND date >= date('now',?)
    ORDER BY date DESC,keyword LIMIT 100`)
    .bind(googleSub,itemId,'-'+days+' days').all();
  return (results??[]).map(({resultsJson,...row})=>({...row,results:JSON.parse(resultsJson)}));
}

export async function getGoogleSearchSnapshots(db, googleSub, itemId, days = 30, limit = 30) {
  const {results} = await db.prepare(`SELECT date,keyword,market,device,snapshot_id AS snapshotId,
    payload_json AS payloadJson,collected_at AS collectedAt
    FROM google_search_snapshots
    WHERE google_sub=? AND item_id=? AND date >= date('now',?)
    ORDER BY date DESC,keyword LIMIT ?`)
    .bind(googleSub,itemId,'-'+days+' days',limit).all();
  return (results??[]).map(({payloadJson,...row})=>({...row,payload:JSON.parse(payloadJson)}));
}
