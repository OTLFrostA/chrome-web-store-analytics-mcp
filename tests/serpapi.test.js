import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { SERPAPI_SETTINGS_HTML } from '../src/serpapi-setup-ui.js';
import { saveSerpApiKey, readSerpApiKey, hasSerpApiKey, deleteSerpApiKey } from '../src/collection/credentials.js';
import { runOneCollector } from '../src/collection/runner.js';
import {
  isTargetStoreUrl, findGoogleStoreRank, verifySerpApiKey,
  updateGoogleSearchKeywords, listGoogleSearchKeywords,
  setGoogleSearchMonthlyLimit, getGoogleSearchBudget,
  collectGoogleSearchRankings, getGoogleSearchHistory,
} from '../src/collection/serpapi.js';

const firstId='ldpbiafkgjlaooeplkiooljccpalpkgf';
const secondId='jfepajhaapfonhhfjmamediilplchakk';
const now=Date.UTC(2026,10,4,16);

function mockD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0002_google_search.sql', import.meta.url),'utf8'));
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const statement=sqlite.prepare(sql);
          return {
            async first() {return statement.get(...args)??null;},
            async all() {return {results:statement.all(...args)};},
            async run() {return {meta:{changes:Number(statement.run(...args).changes)}};},
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results=[];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec('COMMIT');
        return results;
      } catch(error) {sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return {sqlite,db};
}

function mockKV() {
  const values=new Map();
  return {
    values,
    async put(key,value) {values.set(key,value);},
    async get(key,format) {
      const value=values.get(key);
      if (format==='json') return value?JSON.parse(value):null;
      return value??null;
    },
    async delete(key){values.delete(key);},
  };
}

test('only the requested extension on an authentic Chrome Web Store URL matches Google results',()=>{
  assert.equal(isTargetStoreUrl('https://chromewebstore.google.com/detail/some-name/'+firstId,firstId),true);
  assert.equal(isTargetStoreUrl('https://chrome.google.com/webstore/detail/old/'+firstId,firstId),true);
  assert.equal(isTargetStoreUrl('https://chromewebstore.google.com.evil.example/detail/'+firstId,firstId),false);
  assert.equal(isTargetStoreUrl('http://chromewebstore.google.com/detail/'+firstId,firstId),false);
  assert.equal(isTargetStoreUrl('https://chromewebstore.google.com/detail/'+secondId,firstId),false);
  assert.equal(findGoogleStoreRank([
    {position:2,link:'https://example.com/'},
    {position:8,link:'https://chromewebstore.google.com/detail/'+firstId,title:'Matched'},
  ],firstId).rank,8);
  assert.equal(findGoogleStoreRank([{position:1,link:'https://chromewebstore.google.com/detail/'+secondId}],firstId),null);
});

test('SerpAPI Account API verification never returns API key or account email', async()=>{
  let queried;
  const result=await verifySerpApiKey('example-valid-key-for-testing',async(url,options)=>{
    queried={url:new URL(url),options};
    return Response.json({account_id:'account1',api_key:'example-valid-key-for-testing',
      account_email:'private@example.com',plan_name:'Free',searches_per_month:200,
      total_searches_left:74});
  });
  assert.equal(queried.url.origin,'https://serpapi.com');
  assert.equal(queried.url.pathname,'/account.json');
  assert.equal(queried.url.searchParams.get('api_key'),'example-valid-key-for-testing');
  assert.deepEqual(queried.options,{redirect:'manual'});
  assert.deepEqual(result,{plan:'Free',searchesPerMonth:200,searchesLeft:74});
  assert.doesNotMatch(JSON.stringify(result),/example-valid|private@example/);
  await assert.rejects(verifySerpApiKey('bad-key',async()=>new Response('no',{status:401})),/HTTP 401/);
});

test('SerpAPI verification rejects redirects without following secret-bearing requests',async()=>{
  let calls=0;
  await assert.rejects(verifySerpApiKey('private-key-for-testing',async(url,options)=>{
    calls++;
    assert.equal(new URL(url).hostname,'serpapi.com');
    assert.deepEqual(options,{redirect:'manual'});
    return new Response(null,{status:302,headers:{Location:'https://attacker.example/collect'}});
  }),/HTTP 302/);
  assert.equal(calls,1);
});

test('each Google account has its own encrypted SerpAPI key; none is returned in settings',async()=>{
  const kv=mockKV();
  const env={SCHEDULE_TOKEN_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),OAUTH_KV:kv};
  await saveSerpApiKey(env,'alice','alice-secret-api-key-123456');
  await saveSerpApiKey(env,'bob','bob-secret-api-key-12345678');
  assert.equal(await hasSerpApiKey(env,'alice'),true);
  assert.equal(await readSerpApiKey(env,'alice'),'alice-secret-api-key-123456');
  assert.equal(await readSerpApiKey(env,'bob'),'bob-secret-api-key-12345678');
  assert.doesNotMatch(JSON.stringify([...kv.values.values()]),/alice-secret|bob-secret/);
  // A record encrypted for Alice cannot decrypt using Bob's authenticated identity.
  kv.values.set('user-serpapi:credential:v1:bob',kv.values.get('user-serpapi:credential:v1:alice'));
  await assert.rejects(readSerpApiKey(env,'bob'));
  await deleteSerpApiKey(env,'alice');
  assert.equal(await readSerpApiKey(env,'alice'),null);
});

test('Google search keywords and budget are runtime D1 data scoped to the user and extension',async()=>{
  const {sqlite,db}=mockD1();
  try{
    assert.deepEqual(await updateGoogleSearchKeywords(db,'alice',firstId,
      [' Gemini Exporter ','gemini exporter','Another Phrase']),['gemini exporter','Another Phrase']);
    assert.deepEqual(await listGoogleSearchKeywords(db,'bob',firstId),[]);
    assert.deepEqual(await listGoogleSearchKeywords(db,'alice',secondId),[]);
    assert.equal((await listGoogleSearchKeywords(db,'alice',firstId)).length,2);
    assert.deepEqual(await updateGoogleSearchKeywords(db,'alice',firstId,[]),[]);
    assert.deepEqual(await listGoogleSearchKeywords(db,'alice',firstId),[]);
    await setGoogleSearchMonthlyLimit(db,'alice',6);
    assert.equal((await getGoogleSearchBudget(db,'alice',now)).monthlyLimit,6);
    assert.equal((await getGoogleSearchBudget(db,'bob',now)).monthlyLimit,200);
  }finally{sqlite.close();}
});

test('SerpAPI monthly budget and per-keyword day reservations prevent repeat spending',async()=>{
  const {sqlite,db}=mockD1();
  const calls=[];
  try{
    await setGoogleSearchMonthlyLimit(db,'alice',1);
    const keywords=[{keyword:'my extension',market:'us/en',device:'desktop'},
      {keyword:'another phrase',market:'us/en',device:'desktop'}];
    const request=async (url,options)=>{
      assert.deepEqual(options,{redirect:'manual'});
      const parsed=new URL(url);calls.push(parsed.searchParams.get('q'));
      assert.equal(parsed.hostname,'serpapi.com');
      assert.equal(parsed.searchParams.get('api_key'),'alice-private-token');
      return Response.json({search_metadata:{status:'Success'},organic_results:[
        {position:2,link:'https://chromewebstore.google.com/detail/'+firstId,title:'My Extension'}]});
    };
    const options={env:{MCP_DB:db},googleSub:'alice',item:{itemId:firstId},now,
      keywords,apiKey:'alice-private-token',request};
    const first=await collectGoogleSearchRankings(options);
    assert.equal(first.queried,1);
    assert.equal(first.skipped,1);
    assert.deepEqual(calls,['my extension']);
    await collectGoogleSearchRankings(options);
    assert.deepEqual(calls,['my extension']);
    const historic=await getGoogleSearchHistory(db,'alice',firstId,90);
    assert.equal(historic.length,1);
    assert.equal(historic[0].rank,2);
    assert.equal((await getGoogleSearchBudget(db,'alice',now)).requestedThisMonth,1);
    assert.equal((await getGoogleSearchBudget(db,'bob',now)).requestedThisMonth,0);
  }finally{sqlite.close();}
});

test('Google rank collector rejects redirects and stores only a redacted HTTP error',async()=>{
  const {sqlite,db}=mockD1();
  let calls=0;
  try{
    await assert.rejects(collectGoogleSearchRankings({
      env:{MCP_DB:db},googleSub:'alice',item:{itemId:firstId},now,
      keywords:[{keyword:'sensitive-term',market:'us/en',device:'desktop'}],
      apiKey:'private-key-for-testing',
      request:async(url,options)=>{
        calls++;
        assert.equal(new URL(url).hostname,'serpapi.com');
        assert.deepEqual(options,{redirect:'manual'});
        return new Response(null,{status:302,headers:{Location:'https://attacker.example/collect'}});
      },
    }),/failed for 1 keyword/);
    assert.equal(calls,1);
    const saved=await db.prepare('SELECT status,error_code FROM google_search_history WHERE google_sub=?')
      .bind('alice').all();
    assert.deepEqual(saved.results,[{status:'error',error_code:'http_302'}]);
  }finally{sqlite.close();}
});

test('Google rank collector skips without user-owned key and never registers a run',async()=>{
  const statements=[];
  const env={
    MCP_DB:{prepare(sql){
      statements.push(sql);
      if(!sql.includes('google_search_keywords'))throw new Error('Unexpected D1 access');
      return {bind(){return {async all(){return {results:[{keyword:'my term',market:'us/en',device:'desktop'}]};}};}};
    }},
    OAUTH_KV:mockKV(),
  };
  const result=await runOneCollector({env,googleSub:'alice',item:{itemId:firstId},taskId:'google-search-ranking'});
  assert.deepEqual(result,{taskId:'google-search-ranking',skipped:true,
    reason:'No user-owned SerpAPI key configured.'});
  assert.equal(statements.length,1);
});

test('private MCP Apps key form uses a password field, does not persist keys in the browser',()=>{
  const script=SERPAPI_SETTINGS_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Script(script[1]));
  assert.match(SERPAPI_SETTINGS_HTML,/type="password"/);
  assert.match(SERPAPI_SETTINGS_HTML,/callTool\("set_serpapi_key"/);
  assert.match(SERPAPI_SETTINGS_HTML,/callTool\("remove_serpapi_key"/);
  assert.doesNotMatch(SERPAPI_SETTINGS_HTML,/localStorage|sessionStorage|innerHTML\s*=/);
});
