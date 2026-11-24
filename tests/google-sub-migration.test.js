import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createDataSource, getDataSource, listDataSources } from '../src/data-sources.js';
import { deleteOwnedDataSources } from '../src/source-account-cleanup.js';
import { readGa4History } from '../src/collection/ga4.js';
import { saveProviderGrant, readProviderGrant } from '../src/collection/provider-credentials.js';

const migrations=['0006_data_sources.sql','0007_source_oauth_state.sql',
  '0008_app_user_identity.sql','0009_ga4.sql','0010_google_sub_ownership.sql'];
const sql=name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
const scope='https://www.googleapis.com/auth/analytics.readonly';
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  for(const name of migrations.slice(0,-1))db.exec(sql(name));
  return db;
}
function migrate(db){
  db.exec('BEGIN');
  try{db.exec(sql(migrations.at(-1)));db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');throw error;}
}
function seed(db,sub,id,source){
  db.prepare('INSERT INTO app_users(user_id) VALUES(?)').run(id);
  db.prepare('INSERT INTO app_user_identities VALUES(?,?,?,CURRENT_TIMESTAMP)').run('mcp','google-'+sub,id);
  db.prepare(`INSERT INTO data_sources(source_id,owner_user_id,source_type,provider,
    external_resource_id,display_name,auth_status) VALUES(?,?,'ga4','google','123','Analytics','connected')`).run(source,id);
  db.prepare(`INSERT INTO data_source_authorizations(source_id,owner_user_id,provider,
    auth_kind,granted_scopes,status) VALUES(?,?,'google','oauth',?,'connected')`).run(source,id,JSON.stringify([scope]));
  db.prepare("INSERT INTO data_source_collectors(source_id,collector_id,enabled) VALUES(?,'ga4-analytics',1)").run(source);
  db.prepare("INSERT INTO ga4_daily_history(source_id,date,active_users,sessions,page_views) VALUES(?,'2026-11-23',5,6,7)").run(source);
  db.prepare("INSERT INTO ga4_channel_history(source_id,date,source_medium,sessions,active_users) VALUES(?,'2026-11-23','google / organic',2,2)").run(source);
}
function adapter(db){
  return {prepare(query){const stmt=db.prepare(query);return{bind(...args){return{
    async first(){return stmt.get(...args)??null;},
    async all(){return{results:stmt.all(...args)};},
    async run(){return{meta:{changes:Number(stmt.run(...args).changes)}};}
  };}};}};
}
test('migration works on a fresh installation',()=>{
  const db=fixture();migrate(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM data_sources').get().n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('app_users','app_user_identities')").get().n,0);
  db.close();
});
test('migration preserves both owners, source IDs, history and collector settings, requires new source consent',async()=>{
  const db=fixture();seed(db,'alice','legacy-a','source-a');seed(db,'bob','legacy-b','source-b');
  migrate(db);
  const wrapped=adapter(db);
  assert.equal((await listDataSources(wrapped,'alice'))[0].sourceId,'source-a');
  assert.equal((await listDataSources(wrapped,'bob'))[0].sourceId,'source-b');
  assert.equal((await getDataSource(wrapped,'alice','source-a')).authStatus,'reauthorization_required');
  await assert.rejects(getDataSource(wrapped,'alice','source-b'),/not found/);
  const a=await readGa4History(wrapped,{googleSub:'alice',sourceId:'source-a',
    dateFrom:'2026-11-23',dateTo:'2026-11-23'});
  assert.equal(a.daily[0].sessions,6);
  assert.equal(a.channels[0].sessions,2);
  await assert.rejects(readGa4History(wrapped,{googleSub:'alice',sourceId:'source-b',
    dateFrom:'2026-11-23',dateTo:'2026-11-23'}),/not found/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM data_source_collectors WHERE enabled=1').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM data_source_authorizations').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ga4_daily_history').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ga4_channel_history').get().n,2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('app_users','app_user_identities')").get().n,0);
  // A new user may register the same external resource without accessing either owner.
  const c=await createDataSource(wrapped,{googleSub:'charlie',sourceType:'ga4',
    externalResourceId:'123',displayName:'Analytics'});
  assert.notEqual(c.sourceId,'source-a');
  assert.notEqual(c.sourceId,'source-b');
  db.close();
});
for(const [name,corrupt] of [
  ['missing identity',db=>db.exec("DELETE FROM app_user_identities WHERE user_id='legacy-a'")],
  ['ambiguous identity',db=>db.exec("INSERT INTO app_user_identities VALUES('mcp','google-other','legacy-a',CURRENT_TIMESTAMP)")],
  ['authorization owner mismatch',db=>db.exec("UPDATE data_source_authorizations SET owner_user_id='wrong'")],
  ['active OAuth transaction',db=>db.exec("INSERT INTO source_oauth_states(state,owner_user_id,source_id,expires_at) VALUES('state','legacy-a','source-a',unixepoch()+600)")],
]){
  test('migration fails closed on '+name,()=>{
    const db=fixture();seed(db,'alice','legacy-a','source-a');corrupt(db);
    assert.throws(()=>migrate(db),/CHECK constraint failed/);
    assert.equal(db.prepare("SELECT owner_user_id FROM data_sources WHERE source_id='source-a'").get().owner_user_id,'legacy-a');
    assert.equal(db.prepare('SELECT count(*) AS n FROM ga4_daily_history').get().n,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='_google_sub_migration_guard'").get().n,0);
    db.close();
  });
}
test('account cleanup deletes only the verified Google subject and its credentials',async()=>{
  const db=fixture();seed(db,'alice','legacy-a','source-a');seed(db,'bob','legacy-b','source-b');migrate(db);
  const kv=new Map(),env={MCP_DB:adapter(db),SCHEDULE_TOKEN_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    OAUTH_KV:{async put(k,v){kv.set(k,v);},async get(k,format){const v=kv.get(k);return v&&format==='json'?JSON.parse(v):v;},
      async delete(k){kv.delete(k);}}};
  for(const [owner,connectionId] of [['alice','source-a'],['bob','source-b']])
    await saveProviderGrant(env,{owner,connectionId,provider:'google',kind:'oauth',token:owner+'-token',scopes:[scope]});
  assert.deepEqual(await deleteOwnedDataSources(env,'alice'),{removed:1});
  assert.equal((await listDataSources(env.MCP_DB,'alice')).length,0);
  assert.equal((await listDataSources(env.MCP_DB,'bob')).length,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ga4_daily_history').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ga4_channel_history').get().n,1);
  await assert.rejects(readProviderGrant(env,{owner:'alice',provider:'google',connectionId:'source-a',kind:'oauth',scopes:[scope]}));
  assert.equal(await readProviderGrant(env,{owner:'bob',provider:'google',connectionId:'source-b',kind:'oauth',scopes:[scope]}),'bob-token');
  db.close();
});
