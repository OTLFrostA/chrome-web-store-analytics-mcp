import { JOBS } from "../jobs.js";
import { queryAndStoreMetricsBatch, googleQueryAccess } from "../query-service.js";

export { fetchMetricBatch } from "../query.js";

export async function collectMetrics({env,googleSub,item,refreshToken,request=fetch,paceMs=3200}) {
  let nextRequestAt=0;
  const paced=async(url,options)=>{
    const pause=Math.max(0,nextRequestAt-Date.now());
    if (pause) await new Promise(resolve=>setTimeout(resolve,pause));
    nextRequestAt=Date.now()+paceMs;
    return request(url,options);
  };
  const access=await googleQueryAccess({env,googleSub,refreshToken,request:paced});
  const success=await env.MCP_DB.prepare(`SELECT 1 FROM collector_runs WHERE google_sub=? AND item_id=?
    AND task_id='cws-analytics' AND status='succeeded' LIMIT 1`)
    .bind(googleSub,item.itemId).first();
  const days=success?14:90;
  let written=0;
  for (const job of JOBS) {
    const rows=await queryAndStoreMetricsBatch({
      db:env.MCP_DB,googleSub,item,job,days,token:access.token,request:access.request,
    });
    written+=rows.length;
  }
  return {rowsWritten:written,daysRequested:days,jobsExecuted:JOBS.length};
}
