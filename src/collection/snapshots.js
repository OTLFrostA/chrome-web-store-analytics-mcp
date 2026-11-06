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

// Keep individual D1 values small. Large Bright Data records can exceed the
// original 1.5 MB JSON guard even when each result is valid and complete.
// The primary snapshot row is an ACK: write every chunk before publishing it.
const CHUNK_MARKER = "__cws_chunked_snapshot_v1";
const CHUNK_CHARS = 90_000;

function splitJsonText(text) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    // D1 stores UTF-8. Do not cut a JavaScript UTF-16 surrogate pair in half.
    if (end < text.length) {
      const left = text.charCodeAt(end - 1), right = text.charCodeAt(end);
      if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function saveGoogleSearchSnapshots(db, googleSub, itemId, date,
  snapshotId, records) {
  if (!records.length) return 0;
  const parentSql = `INSERT INTO google_search_snapshots
    (google_sub,item_id,date,keyword,market,device,snapshot_id,payload_json)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(google_sub,item_id,date,keyword,market,device)
    DO UPDATE SET snapshot_id=excluded.snapshot_id,payload_json=excluded.payload_json,
    collected_at=CURRENT_TIMESTAMP`;
  const chunkSql = `INSERT INTO google_search_snapshot_chunks
    (google_sub,item_id,date,keyword,market,device,snapshot_id,part_index,chunk_text)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(
      google_sub,item_id,date,keyword,market,device,snapshot_id,part_index)
    DO UPDATE SET chunk_text=excluded.chunk_text`;

  for (const {keyword,market,device,payload} of records) {
    const json = JSON.stringify(payload);
    if (typeof json !== "string") throw new Error("External query response is not JSON.");
    let payloadJson = json;
    if (new TextEncoder().encode(json).length > MAX_JSON_BYTES) {
      const chunks = splitJsonText(json);
      const statements = chunks.map((chunk,partIndex) => db.prepare(chunkSql).bind(
        googleSub,itemId,date,keyword,market,device,snapshotId,partIndex,chunk));
      // Small batches also bound the total D1 request size.
      for (let i = 0; i < statements.length; i += 3) {
        await db.batch(statements.slice(i,i+3));
      }
      payloadJson = JSON.stringify({[CHUNK_MARKER]: chunks.length});
    }
    // Commit the completion marker only after every data chunk is durable.
    await db.prepare(parentSql).bind(googleSub,itemId,date,keyword,market,device,
      snapshotId,payloadJson).run();
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
  const output = [];
  for (const {payloadJson,...row} of results??[]) {
    let payload = JSON.parse(payloadJson);
    const count = payload && typeof payload === "object" && !Array.isArray(payload) &&
      Object.keys(payload).length === 1 ? payload[CHUNK_MARKER] : null;
    if (Number.isInteger(count) && count > 0) {
      const {results:parts} = await db.prepare(`SELECT part_index AS partIndex,
        chunk_text AS chunkText FROM google_search_snapshot_chunks
        WHERE google_sub=? AND item_id=? AND date=? AND keyword=? AND market=? AND device=?
        AND snapshot_id=? ORDER BY part_index`).bind(
        googleSub,itemId,row.date,row.keyword,row.market,row.device,row.snapshotId).all();
      if (!parts || parts.length !== count || parts.some((part,i)=>part.partIndex!==i)) {
        throw new Error("Bright Data snapshot chunks are incomplete.");
      }
      payload = JSON.parse(parts.map(part=>part.chunkText).join(""));
    }
    output.push({...row,payload});
  }
  return output;
}
