import { getDataSource } from '../data-sources.js';
import { resolveDataSourceCredential } from '../authorization-manager.js';

// Execution boundary for source-bound collectors. Collector implementations are
// injected by the registry; they cannot infer credentials from collector IDs.
export async function executeSourceCollector({env,ownerUserId,sourceId,collector,now=Date.now()}) {
  if(!collector||typeof collector.id!=='string'||!Array.isArray(collector.sourceTypes)||
    typeof collector.collect!=='function')throw new TypeError('Invalid collector registration.');
  const source=await getDataSource(env.MCP_DB,ownerUserId,sourceId);
  if(source.enabled!==1)throw new Error('Data source is disabled.');
  if(!collector.sourceTypes.includes(source.sourceType))
    throw new Error('Collector cannot run against this data source type.');
  const auth=await resolveDataSourceCredential({env,ownerUserId,sourceId});
  // The downstream adapter owns token refresh; no auth logic belongs to the collector scheduler.
  return collector.collect({env,source,auth,now});
}
