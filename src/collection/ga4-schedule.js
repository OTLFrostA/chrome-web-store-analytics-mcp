import { localDay, localHour } from './time.js';
import { collectGa4Source } from './ga4.js';

// GA4 reporting dates are property-local. At 9AM Pacific fetch a rolling seven-day
// window, allowing previous days to settle; each daily write is an idempotent replacement.
export function dueGa4Range(scheduledTime) {
  if(localHour(scheduledTime)!==9)return null;
  const today=localDay(scheduledTime);
  const start=new Date(today+'T00:00:00Z');
  const day=offset=>{
    const d=new Date(start);
    d.setUTCDate(d.getUTCDate()+offset);
    return d.toISOString().slice(0,10);
  };
  return {dateFrom:day(-7),dateTo:day(-1)};
}
export async function setGa4DailyCollection(db,{ownerUserId,sourceId,enabled}) {
  const {getDataSource,configureSourceCollector}=await import('../data-sources.js');
  const source=await getDataSource(db,ownerUserId,sourceId);
  if(source.sourceType!=='ga4')throw new Error('This source is not a GA4 property.');
  if(enabled&&source.authStatus!=='connected')
    throw new Error('Authorize this GA4 data source before enabling collection.');
  await configureSourceCollector(db,{ownerUserId,sourceId,collectorId:'ga4-analytics',enabled});
  return {sourceId,enabled};
}
async function claim(db,sourceId,dateFrom,dateTo) {
  const runId=crypto.randomUUID();
  const response=await db.prepare(`INSERT OR IGNORE INTO source_collector_runs
    (run_id,source_id,collector_id,date_from,date_to,trigger_kind,status)
    VALUES (?,?,?, ?, ?,'scheduled','running')`)
    .bind(runId,sourceId,'ga4-analytics',dateFrom,dateTo).run();
  return (response.meta?.changes??0)===1?runId:null;
}
export async function collectScheduledGa4(env,scheduledTime) {
  const range=dueGa4Range(scheduledTime);
  if(!range)return {skipped:true,reason:'GA4 collector is not due'};
  const {results}=await env.MCP_DB.prepare(`SELECT ds.source_id AS sourceId,
    ds.owner_user_id AS ownerUserId FROM data_sources ds
    INNER JOIN data_source_collectors c ON c.source_id=ds.source_id
    AND c.collector_id='ga4-analytics' AND c.enabled=1
    WHERE ds.source_type='ga4' AND ds.enabled=1 AND ds.auth_status='connected'
    ORDER BY ds.source_id LIMIT 20`).all();
  const runs=[];
  for(const source of results??[]){
    const runId=await claim(env.MCP_DB,source.sourceId,range.dateFrom,range.dateTo);
    if(!runId){runs.push({sourceId:source.sourceId,skipped:true});continue;}
    try {
      const outcome=await collectGa4Source({env,ownerUserId:source.ownerUserId,
        sourceId:source.sourceId,...range});
      await env.MCP_DB.prepare(`UPDATE source_collector_runs
        SET status='succeeded',rows_written=?,finished_at=CURRENT_TIMESTAMP
        WHERE run_id=?`).bind(outcome.rowsWritten,runId).run();
      runs.push({sourceId:source.sourceId,status:'succeeded',rowsWritten:outcome.rowsWritten});
    }catch(error){
      // Never persist upstream response bodies, access tokens, or sensitive paths.
      await env.MCP_DB.prepare(`UPDATE source_collector_runs
        SET status='failed',error_code='collection_failed',finished_at=CURRENT_TIMESTAMP
        WHERE run_id=?`).bind(runId).run();
      runs.push({sourceId:source.sourceId,status:'failed'});
    }
  }
  return {dateFrom:range.dateFrom,dateTo:range.dateTo,runs};
}
