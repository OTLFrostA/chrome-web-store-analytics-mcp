import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDefinition, createDataSource, getDataSource, listDataSources } from '../src/data-sources.js';
import { beginSourceOAuth, completeSourceOAuth } from '../src/source-oauth.js';
import { readProviderGrant } from '../src/collection/provider-credentials.js';

function fixture() {
  const sources=[], pending=new Map(),grants=new Map(),kv=new Map();
  const db={prepare(sql){return{bind(...args){return{
    async run(){
      if(sql.includes('INSERT INTO data_sources')) {
        const [id,owner,type,provider,externalResourceId,displayName]=args;
        if(!sources.some(s=>s.ownerUserId===owner&&s.sourceType===type&&s.externalResourceId===externalResourceId))
          sources.push({sourceId:id,ownerUserId:owner,sourceType:type,provider,
            externalResourceId,displayName,authStatus:'disconnected',enabled:1});
        return {meta:{changes:1}};
      }
      if(sql.includes('INSERT INTO source_oauth_states')) {
        pending.set(args[0],{ownerUserId:args[1],sourceId:args[2],expiresAt:args[3],consumed:0});
        return {meta:{changes:1}};
      }
      if(sql.includes('UPDATE source_oauth_states')) {
        const row=pending.get(args[0]);
        if(!row||row.consumed||row.expiresAt<=args[1])return {meta:{changes:0}};
        row.consumed=1;return{meta:{changes:1}};
      }
      if(sql.includes('UPDATE data_sources')) {
        const row=sources.find(s=>s.ownerUserId===args[1]&&s.sourceId===args[2]);
        if(row)row.authStatus=args[0];return{meta:{changes:row?1:0}};
      }
      if(sql.includes('INSERT INTO data_source_authorizations')) {
        grants.set(args[0],{ownerUserId:args[1],status:'connected',authKind:args[3],grantedScopes:args[5]});
        return{meta:{changes:1}};
      }
      throw Error('Unexpected SQL run: '+sql);
    },
    async first(){
      if(sql.includes('FROM data_sources')) {
        const row=sources.find(s=>s.ownerUserId===args[0]&&
          (sql.includes('WHERE owner_user_id=? AND source_id=?')?s.sourceId===args[1]:
            s.sourceType===args[1]&&s.externalResourceId===args[2]));
        return row??null;
      }
      if(sql.includes('FROM source_oauth_states'))return pending.get(args[0])??null;
      if(sql.includes('FROM data_source_authorizations'))return grants.get(args[1])??null;
      throw Error('Unexpected SQL first: '+sql);
    },
    async all(){if(sql.includes('FROM data_sources'))return{results:sources.filter(s=>s.ownerUserId===args[0])};throw Error(sql);}
  };}};}};
  const env={MCP_DB:db,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',
    MCP_RESOURCE:'https://example.com/mcp',
    SCHEDULE_TOKEN_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    OAUTH_KV:{
      async put(k,v){kv.set(k,v);},
      async get(k,format){const v=kv.get(k);return format==='json'&&v?JSON.parse(v):v;},
      async delete(k){kv.delete(k);},
    }};
  return {env,sources,pending,grants,kv};
}

test('owner and source are separate from provider identity and collector',async()=>{
  const {env}=fixture();
  const a=await createDataSource(env.MCP_DB,{ownerUserId:'user-a',sourceType:'ga4',
    externalResourceId:'551943445',displayName:'CWS GA4'});
  const b=await createDataSource(env.MCP_DB,{ownerUserId:'user-b',sourceType:'ga4',
    externalResourceId:'551943445',displayName:'CWS GA4'});
  assert.notEqual(a.sourceId,b.sourceId);
  assert.equal(sourceDefinition('ga4').provider,'google');
  assert.equal((await listDataSources(env.MCP_DB,'user-a')).length,1);
  await assert.rejects(getDataSource(env.MCP_DB,'user-a',b.sourceId),/not found/);
});

test('OAuth state is source-specific, PKCE-protected and one-time',async()=>{
  const {env}=fixture();
  const source=await createDataSource(env.MCP_DB,{ownerUserId:'user-a',
    sourceType:'ga4',externalResourceId:'551943445',displayName:'GA4'});
  const start=await beginSourceOAuth({env,ownerUserId:'user-a',
    sourceId:source.sourceId,baseUrl:'https://example.com/mcp'});
  const authorize=new URL(start.authorizationUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'),'https://example.com/source-oauth/callback');
  assert.match(authorize.searchParams.get('scope'),/analytics\.readonly/);
  assert.doesNotMatch(authorize.searchParams.get('scope'),/chromewebstore\.readonly/);
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  const callback=new Request('https://example.com/source-oauth/callback?state='+
    authorize.searchParams.get('state')+'&code=sample');
  const scopes='openid email https://www.googleapis.com/auth/analytics.readonly';
  const requestToken=async(url,options)=>{
    assert.equal(new URL(url).hostname,'oauth2.googleapis.com');
    assert.ok(options.body.get('code_verifier'));
    return new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',scope:scopes}),{status:200});
  };
  const requestIdentity=async()=>new Response(JSON.stringify({sub:'provider-google-sub',
    email_verified:true}),{status:200});
  const done=await completeSourceOAuth(callback,env,{requestToken,requestIdentity});
  assert.equal(done.status,'connected');
  assert.equal(await readProviderGrant(env,{owner:'user-a',provider:'google',
    connectionId:source.sourceId,kind:'oauth',scopes:[sourceDefinition('ga4').scopes[0]]}),'refresh');
  await assert.rejects(completeSourceOAuth(callback,env,{requestToken,requestIdentity}),
    /already used/);
  await assert.rejects(readProviderGrant(env,{owner:'user-b',provider:'google',
    connectionId:source.sourceId,kind:'oauth',scopes:sourceDefinition('ga4').scopes}));
});

test('OAuth denies missing scopes without storing token',async()=>{
  const {env}=fixture();
  const source=await createDataSource(env.MCP_DB,{ownerUserId:'user-a',sourceType:'ga4',
    externalResourceId:'551943445',displayName:'GA4'});
  const start=await beginSourceOAuth({env,ownerUserId:'user-a',
    sourceId:source.sourceId,baseUrl:'https://example.com/mcp'});
  const state=new URL(start.authorizationUrl).searchParams.get('state');
  const callback=new Request('https://example.com/source-oauth/callback?state='+state+'&code=sample');
  await assert.rejects(completeSourceOAuth(callback,env,{
    requestToken:async()=>new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',
      scope:'openid email'})),requestIdentity:async()=>{throw Error('Should not query identity');},
  }),/Required Google scope/);
  await assert.rejects(readProviderGrant(env,{owner:'user-a',provider:'google',
    connectionId:source.sourceId,kind:'oauth',scopes:sourceDefinition('ga4').scopes}));
});
