// Domain model: users own data sources; collectors run against sources; authorization belongs to a source.
// Never treat an MCP session, a Google account or a collector ID as a data source.
export const SOURCE_TYPES = Object.freeze({
  cws: Object.freeze({ provider:'google', authKind:'oauth',
    scopes:Object.freeze(['https://www.googleapis.com/auth/chromewebstore.readonly']) }),
  ga4: Object.freeze({ provider:'google', authKind:'oauth',
    scopes:Object.freeze(['https://www.googleapis.com/auth/analytics.readonly']) }),
  brightdata: Object.freeze({ provider:'brightdata', authKind:'api-key', scopes:Object.freeze([]) }),
  public: Object.freeze({ provider:'public', authKind:'none', scopes:Object.freeze([]) }),
});

export function sourceDefinition(type) {
  const definition=Object.hasOwn(SOURCE_TYPES,type) ? SOURCE_TYPES[type] : null;
  if(!definition) throw new TypeError('Unknown data source type.');
  return definition;
}
function nonempty(value,label) {
  if(typeof value!=='string'||!value.trim()||value.length>250)throw new TypeError('Invalid '+label+'.');
  return value.trim();
}
export async function createDataSource(db,{ownerUserId,sourceType,externalResourceId,displayName}) {
  const owner=nonempty(ownerUserId,'owner'),resource=nonempty(externalResourceId,'resource');
  const definition=sourceDefinition(sourceType);
  const label=nonempty(displayName,'display name');
  const id=crypto.randomUUID();
  await db.prepare(`INSERT INTO data_sources
    (source_id,owner_user_id,source_type,provider,external_resource_id,display_name)
    VALUES (?,?,?,?,?,?) ON CONFLICT(owner_user_id,source_type,external_resource_id) DO NOTHING`)
    .bind(id,owner,sourceType,definition.provider,resource,label).run();
  const row=await db.prepare(`SELECT source_id AS sourceId,owner_user_id AS ownerUserId,
    source_type AS sourceType,provider,external_resource_id AS externalResourceId,
    display_name AS displayName,auth_status AS authStatus,enabled
    FROM data_sources WHERE owner_user_id=? AND source_type=? AND external_resource_id=?`)
    .bind(owner,sourceType,resource).first();
  if(!row)throw new Error('Failed to create data source.');
  return row;
}
export async function getDataSource(db,ownerUserId,sourceId) {
  const row=await db.prepare(`SELECT source_id AS sourceId,owner_user_id AS ownerUserId,
    source_type AS sourceType,provider,external_resource_id AS externalResourceId,
    display_name AS displayName,auth_status AS authStatus,enabled
    FROM data_sources WHERE owner_user_id=? AND source_id=?`).bind(ownerUserId,sourceId).first();
  if(!row)throw new Error('Data source not found for this user.');
  return row;
}
export async function listDataSources(db,ownerUserId) {
  const {results}=await db.prepare(`SELECT source_id AS sourceId,source_type AS sourceType,provider,
    external_resource_id AS externalResourceId,display_name AS displayName,
    auth_status AS authStatus,enabled FROM data_sources WHERE owner_user_id=?
    ORDER BY created_at,source_id`).bind(ownerUserId).all();
  return results??[];
}
export async function setDataSourceAuthStatus(db,ownerUserId,sourceId,status) {
  if(!['disconnected','pending','connected','reauthorization_required'].includes(status)) {
    throw new TypeError('Invalid source authorization status.');
  }
  const result=await db.prepare(`UPDATE data_sources SET auth_status=?,
    updated_at=CURRENT_TIMESTAMP WHERE owner_user_id=? AND source_id=?`)
    .bind(status,ownerUserId,sourceId).run();
  if((result.meta?.changes??0)!==1)throw new Error('Data source not found for this user.');
}
export async function configureSourceCollector(db,{ownerUserId,sourceId,collectorId,enabled}) {
  await getDataSource(db,ownerUserId,sourceId);
  if(typeof collectorId!=='string'||!collectorId||typeof enabled!=='boolean')
    throw new TypeError('Invalid collector configuration.');
  await db.prepare(`INSERT INTO data_source_collectors(source_id,collector_id,enabled)
    VALUES (?,?,?) ON CONFLICT(source_id,collector_id) DO UPDATE SET
    enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP`).bind(sourceId,collectorId,Number(enabled)).run();
}
