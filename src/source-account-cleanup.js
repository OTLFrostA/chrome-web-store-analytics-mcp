import { deleteProviderGrant } from './collection/provider-credentials.js';

// Removing a login account must also erase its independently scoped downstream
// grants. Otherwise disconnected users could leave GA4 scheduled collection active.
export async function deleteOwnedDataSources(env,googleSub) {
  const identity='google-'+googleSub;
  const user=await env.MCP_DB.prepare(`SELECT user_id AS userId FROM app_user_identities
    WHERE identity_provider='mcp' AND identity_subject=?`).bind(identity).first();
  if(!user)return {removed:0};
  const {results}=await env.MCP_DB.prepare(`SELECT source_id AS sourceId,provider
    FROM data_sources WHERE owner_user_id=?`).bind(user.userId).all();
  for(const row of results??[]) {
    // Remove secrets before deleting metadata. Any failure stops the removal;
    // the account cleanup caller reports the partial result.
    await deleteProviderGrant(env,{owner:user.userId,provider:row.provider,
      connectionId:row.sourceId});
  }
  await env.MCP_DB.batch([
    env.MCP_DB.prepare('DELETE FROM data_sources WHERE owner_user_id=?').bind(user.userId),
    env.MCP_DB.prepare(`DELETE FROM app_user_identities WHERE identity_provider='mcp'
      AND identity_subject=?`).bind(identity),
    env.MCP_DB.prepare(`DELETE FROM app_users WHERE user_id=? AND
      NOT EXISTS(SELECT 1 FROM app_user_identities WHERE user_id=?)`)
      .bind(user.userId,user.userId),
  ]);
  return {removed:results?.length??0};
}
