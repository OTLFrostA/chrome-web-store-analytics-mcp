import { deleteProviderGrant } from './collection/provider-credentials.js';

// The OAuth-verified Google subject is the only tenant identity.
// Remove only this account's downstream credentials and source history.
export async function deleteOwnedDataSources(env,googleSub) {
  const {results}=await env.MCP_DB.prepare(`SELECT source_id AS sourceId,provider
    FROM data_sources WHERE google_sub=?`).bind(googleSub).all();
  for(const row of results??[]) {
    await deleteProviderGrant(env,{owner:googleSub,provider:row.provider,
      connectionId:row.sourceId});
  }
  await env.MCP_DB.prepare('DELETE FROM data_sources WHERE google_sub=?').bind(googleSub).run();
  return {removed:results?.length??0};
}
