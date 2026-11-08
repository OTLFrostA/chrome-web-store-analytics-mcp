import { getDataSource, setDataSourceAuthStatus, sourceDefinition } from './data-sources.js';
import { saveProviderGrant, readProviderGrant, deleteProviderGrant } from './collection/provider-credentials.js';

// Exclusive owner of downstream credentials and authorization metadata.
// The MCP client's own OAuth grant is not a downstream data-source authorization.
function grantLocator(source) {
  return { owner: source.ownerUserId, provider: source.provider, connectionId: source.sourceId };
}
export async function authorizeDataSource({ env, ownerUserId, sourceId,
  token, grantedScopes, providerAccountId = null }) {
  const source=await getDataSource(env.MCP_DB,ownerUserId,sourceId);
  const definition=sourceDefinition(source.sourceType);
  if(definition.authKind!=='oauth')throw new Error('Data source is not OAuth-backed.');
  if(!Array.isArray(grantedScopes)||!definition.scopes.every(scope=>grantedScopes.includes(scope)))
    throw new Error('Provider did not grant the required permissions.');
  // This method is server-internal. Call it only after a verified provider callback.
  await saveProviderGrant(env,{...grantLocator(source),kind:'oauth',token,scopes:grantedScopes});
  try {
    await env.MCP_DB.prepare(`INSERT INTO data_source_authorizations
      (source_id,owner_user_id,provider,auth_kind,provider_account_id,granted_scopes,status)
      VALUES (?,?,?,?,?,?,'connected')
      ON CONFLICT(source_id) DO UPDATE SET
      provider_account_id=excluded.provider_account_id,
      granted_scopes=excluded.granted_scopes,status='connected',updated_at=CURRENT_TIMESTAMP`)
      .bind(sourceId,ownerUserId,source.provider,'oauth',providerAccountId,JSON.stringify(grantedScopes)).run();
    await setDataSourceAuthStatus(env.MCP_DB,ownerUserId,sourceId,'connected');
  } catch(error) {
    // Fail closed if D1 cannot commit the authorization metadata.
    await deleteProviderGrant(env,grantLocator(source));
    throw error;
  }
  return {sourceId,status:'connected'};
}
export async function resolveDataSourceCredential({env,ownerUserId,sourceId}) {
  const source=await getDataSource(env.MCP_DB,ownerUserId,sourceId);
  const definition=sourceDefinition(source.sourceType);
  if(definition.authKind==='none')return {source,kind:'none'};
  if(source.authStatus!=='connected')throw new Error('Data source needs authorization.');
  const metadata=await env.MCP_DB.prepare(`SELECT granted_scopes AS grantedScopes,status,auth_kind AS authKind
    FROM data_source_authorizations WHERE owner_user_id=? AND source_id=?`)
    .bind(ownerUserId,sourceId).first();
  if(!metadata||metadata.status!=='connected'||metadata.authKind!==definition.authKind)
    throw new Error('Data source authorization metadata is missing.');
  const grantedScopes=JSON.parse(metadata.grantedScopes);
  if(!Array.isArray(grantedScopes)||!definition.scopes.every(scope=>grantedScopes.includes(scope)))
    throw new Error('Data source has insufficient permissions.');
  const token=await readProviderGrant(env,{...grantLocator(source),
    kind:definition.authKind,scopes:definition.scopes});
  return {source,kind:definition.authKind,token};
}
export async function disconnectDataSourceAuthorization({env,ownerUserId,sourceId}) {
  const source=await getDataSource(env.MCP_DB,ownerUserId,sourceId);
  // Authorization removal is per source: never touch another source, MCP login, or history.
  // This is local disconnection; external provider revocation may require a separate call.
  await deleteProviderGrant(env,grantLocator(source));
  await env.MCP_DB.prepare(`DELETE FROM data_source_authorizations
    WHERE owner_user_id=? AND source_id=?`).bind(ownerUserId,sourceId).run();
  await setDataSourceAuthStatus(env.MCP_DB,ownerUserId,sourceId,'disconnected');
  return {sourceId,status:'disconnected',providerRevoked:false};
}
