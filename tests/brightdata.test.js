import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {BRIGHTDATA_SETTINGS_HTML} from '../src/brightdata-setup-ui.js';
import {saveBrightDataKey,readBrightDataKey,hasBrightDataKey,deleteBrightDataKey} from '../src/collection/credentials.js';
import {runOneCollector} from '../src/collection/runner.js';
import {
  verifyBrightDataKey,isTargetStoreUrl,findGoogleStoreRank,
  updateGoogleSearchKeywords,listGoogleSearchKeywords,
  getGoogleSearchBudget,setGoogleSearchMonthlyLimit,
  submitBrightDataRankings,pollBrightDataRun,parseBrightDataSnapshot,getGoogleSearchHistory,sanitizedHttpError,parseSnapshotId,
} from '../src/collection/brightdata.js';

const firstId = 'ldpbiafkgjlaooeplkiooljccpalpkgf';
const secondId = 'jfepajhaapfonhhfjmamediilplchakk';
const now = Date.UTC(2026,10,4,16);
const key = 'test-bright-data-token-secret';

function mockD1() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0001_collectors.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_google_search.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_unified_queries.sql'),migrations/0005_google_search_snapshot_chunks.sql'',import.meta.url),'utf8'));
  sqlite.prepare('INSERT INTO user_extensions (google_sub,item_id,publisher_id,store_url) VALUES (?,?,?,?)').run('alice',firstId,'publisher-alice','https://example.test/extension');
  const db={
    prepare(sql){return {bind(...args){
      const statement=sqlite.prepare(sql);
      return {
        async first(){return statement.get(...args)??null;},
        async all(){return {results:statement.all(...args)};},
        async run(){return {meta:{changes:Number(statement.run(...args).changes)}};},
      };
    }};},
    async batch(statements){
      sqlite.exec('BEGIN');
      try{
        const result=[];
        for(const stmt of statements) result.push(await stmt.run());
        sqlite.exec('COMMIT');return result;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return {sqlite,db};
}

function mockKV(){
  const values=new Map();
  return {
    values,
    async put(k,v){values.set(k,v);},
    async get(k,fmt){const v=values.get(k);return fmt==='json' && v ? JSON.parse(v) : (v??null);},
    async delete(k){values.delete(k);},
  };
}

test('target matching accepts only verified store URLs and Google-owned redirects',()=>{
  const direct='https://chromewebstore.google.com/detail/example/'+firstId;
  assert.equal(isTargetStoreUrl(direct,firstId),true);
  assert.equal(isTargetStoreUrl('https://chrome.google.com/webstore/detail/old/'+firstId,firstId),true);
  assert.equal(isTargetStoreUrl('https://www.google.com/url?q='+encodeURIComponent(direct),firstId),true);
  assert.equal(isTargetStoreUrl('https://www.google.com/goto?url='+encodeURIComponent(direct),firstId),true);
  assert.equal(isTargetStoreUrl('https://evil.example/goto?url='+encodeURIComponent(direct),firstId),false);
  assert.equal(isTargetStoreUrl('https://chromewebstore.google.com.evil.example/detail/'+firstId,firstId),false);
  assert.equal(isTargetStoreUrl('http://chromewebstore.google.com/detail/'+firstId,firstId),false);
  assert.equal(isTargetStoreUrl('https://chromewebstore.google.com/detail/'+secondId,firstId),false);
  assert.equal(findGoogleStoreRank([{link:'https://example.com',rank:1},{link:direct,title:'Matched',rank:2}],firstId).rank,2);
});

test('Bright Data token verification uses a fixed safe endpoint and never returns secrets',async()=>{
  let calls=0;
  const output=await verifyBrightDataKey(key,async(url,options)=>{
    calls++;
    assert.equal(url,'https://api.brightdata.com/zone/get_active_zones');
    assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,'Bearer '+key);
    return Response.json([{name:'private-zone'}]);
  });
  assert.equal(calls,1);
  assert.deepEqual(output,{verified:true});
  assert.doesNotMatch(JSON.stringify(output),/private-zone|test-bright/);
  await assert.rejects(verifyBrightDataKey(key,async()=>new Response(null,{status:302})),/HTTP 302/);
  await assert.rejects(verifyBrightDataKey(key,async()=>new Response(null,{status:401})),/HTTP 401/);
});

test('Bright Data keys encrypted with user-specific AAD; a successful migration purges legacy key',async()=>{
  const kv=mockKV(),env={SCHEDULE_TOKEN_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),OAUTH_KV:kv};
  kv.values.set('user-serpapi:credential:v1:alice','legacy-encrypted-secret');
  await saveBrightDataKey(env,'alice','alice-brightdata-secret-12345');
  await saveBrightDataKey(env,'bob','bob-brightdata-secret-123456');
  assert.equal(kv.values.has('user-serpapi:credential:v1:alice'),false);
  assert.equal(await hasBrightDataKey(env,'alice'),true);
  assert.equal(await readBrightDataKey(env,'alice'),'alice-brightdata-secret-12345');
  assert.equal(await readBrightDataKey(env,'bob'),'bob-brightdata-secret-123456');
  assert.doesNotMatch(JSON.stringify([...kv.values.values()]),/alice-brightdata-secret|bob-brightdata-secret/);
  kv.values.set('user-brightdata:credential:v1:bob',kv.values.get('user-brightdata:credential:v1:alice'));
  await assert.rejects(readBrightDataKey(env,'bob'));
  await deleteBrightDataKey(env,'alice');
  assert.equal(await readBrightDataKey(env,'alice'),null);
});

test('keyword lists are fully dynamic per user and extension, up to 100 with account budget',async()=>{
  const {sqlite,db}=mockD1();
  try{
    const phrases=Array.from({length:30},(_,i)=>'unique keyword '+i);
    assert.equal((await updateGoogleSearchKeywords(db,'alice',firstId,phrases)).length,30);
    assert.equal((await listGoogleSearchKeywords(db,'alice',firstId)).length,30);
    assert.deepEqual(await listGoogleSearchKeywords(db,'bob',firstId),[]);
    assert.deepEqual(await listGoogleSearchKeywords(db,'alice',secondId),[]);
    assert.deepEqual(await updateGoogleSearchKeywords(db,'alice',firstId,['Gemini Exporter','gemini exporter']),['gemini exporter']);
    assert.equal((await listGoogleSearchKeywords(db,'alice',firstId)).length,1);
    await assert.rejects(updateGoogleSearchKeywords(db,'alice',firstId,Array(101).fill('x')),/0 to 100/);
    await setGoogleSearchMonthlyLimit(db,'alice',4500);
    assert.equal((await getGoogleSearchBudget(db,'alice',now)).monthlyLimit,4500);
    await assert.rejects(setGoogleSearchMonthlyLimit(db,'alice',5001),/between 1 and 5,000/);
    assert.equal((await getGoogleSearchBudget(db,'bob',now)).monthlyLimit,200);
  }finally{sqlite.close();}
});

test('async trigger uses one allowlisted dataset request, observes monthly budget and does not expose token',async()=>{
  const {sqlite,db}=mockD1(),kv=mockKV(), calls=[];
  try{
    await setGoogleSearchMonthlyLimit(db,'alice',1);
    const item={itemId:firstId},runId='test-run';
    const options={env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',item,runId,now,apiKey:key,
      keywords:[{keyword:'term one'},{keyword:'term two'}],
      request:async(url,options)=>{
        calls.push({url,options});
        return Response.json({snapshot_id:'s_abcd12345'});
      }};
    const result=await submitBrightDataRankings(options);
    assert.equal(result.status,'pending');
    assert.equal(result.requested,1);
    assert.equal(result.skipped,1);
    assert.equal(calls.length,1);
    const call=calls[0];
    assert.equal(new URL(call.url).origin,'https://api.brightdata.com');
    assert.equal(new URL(call.url).searchParams.get('dataset_id'),'gd_mfz5x93lmsjjjylob');
    assert.deepEqual(JSON.parse(call.options.body),[
      {url:'https://www.google.com/',keyword:'term one',language:'en',country:'US',start_page:1,end_page:10},
    ]);
    assert.equal(call.options.redirect,'manual');
    assert.equal(call.options.headers.Authorization,'Bearer '+key);
    assert.doesNotMatch(call.url,/test-bright-data-token-secret/);
    assert.doesNotMatch(JSON.stringify([...kv.values.values()]),/test-bright-data-token-secret/);
    assert.equal((await getGoogleSearchBudget(db,'alice',now)).requestedThisMonth,1);
    const again=await submitBrightDataRankings(options);
    assert.equal(again.requested,0);
    assert.equal(calls.length,1);
  }finally{sqlite.close();}
});

test('snapshot polling stores found and not-found ranks exactly once with a completed run',async()=>{
  const {sqlite,db}=mockD1(),kv=mockKV();
  try{
    const runId='run-abc';
    sqlite.prepare("INSERT INTO collector_runs (run_id,google_sub,item_id,task_id,date,trigger_kind,status) VALUES (?,?,?,?,?,'manual','running')")
      .run(runId,'alice',firstId,'google-search-ranking','2026-11-04');
    const keywords=[{keyword:'Gemini Exporter'},{keyword:'chat history exporter'}];
    await submitBrightDataRankings({
      env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',item:{itemId:firstId},
      now,runId,apiKey:key,keywords,request:async()=>Response.json({snapshot_id:'s_ready12345'}),
    });
    let ready=false,downloadCalls=0;
    const request=async(url,opts)=>{
      assert.equal(opts.redirect,'manual');
      assert.equal(opts.headers.Authorization,'Bearer '+key);
      if(url.includes('/progress/'))return Response.json({status:ready?'ready':'running'});
      if(url.includes('/snapshot/')){
        downloadCalls++;
        return Response.json([
          {keyword:'Gemini Exporter',organic:[{rank:1,link:'https://example.com'},
            {rank:2,link:'https://chromewebstore.google.com/detail/a/'+firstId,title:'My extension'}]},
          {keyword:'chat history exporter',organic:[{rank:1,link:'https://example.com/other'}]},
        ]);
      }
      throw Error('unexpected URL');
    };
    assert.equal((await pollBrightDataRun({env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',
      itemId:firstId,runId,apiKey:key,request})).status,'pending');
    ready=true;
    const done=await pollBrightDataRun({env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',
      itemId:firstId,runId,apiKey:key,request});
    assert.equal(done.status,'succeeded');
    assert.equal(done.rowsWritten,2);
    assert.equal(downloadCalls,1);
    const history=sqlite.prepare('SELECT keyword,status,rank,result_count FROM google_search_history ORDER BY keyword').all();
    assert.deepEqual(history.map(x=>({...x})),[
      {keyword:'chat history exporter',status:'not_found',rank:null,result_count:1},
      {keyword:'Gemini Exporter',status:'found',rank:2,result_count:2},
    ]);
    const run=sqlite.prepare('SELECT status,rows_written FROM collector_runs WHERE run_id=?').get(runId);
    assert.equal(run.status,'succeeded');
    assert.equal(run.rows_written,2);
    assert.equal(kv.values.size,0);
  }finally{sqlite.close();}
});

test('unexpected or partial snapshots fail closed rather than recording false not-found ranks',async()=>{
  const entries=[{keyword:'real search',market:'us/en',device:'desktop'}];
  assert.throws(()=>parseBrightDataSnapshot({no:'data'},entries,firstId),/invalid_snapshot_shape/);
  assert.deepEqual(parseBrightDataSnapshot([{keyword:'real search',organic:[]}],entries,firstId)[0].errorCode,
    'missing_organic_results');
  assert.equal(parseBrightDataSnapshot([{keyword:'another',organic:[{link:'https://example.com'}]}],
    entries,firstId)[0].status,'error');
});

test('async trigger never follows redirects to another host with private token',async()=>{
  const {sqlite,db}=mockD1(),kv=mockKV();
  try{
    let calls=0;
    await assert.rejects(submitBrightDataRankings({
      env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',item:{itemId:firstId},
      now,runId:'redirect-run',apiKey:key,keywords:[{keyword:'term'}],
      request:async(url,options)=>{
        calls++;
        assert.equal(new URL(url).hostname,'api.brightdata.com');
        assert.equal(options.redirect,'manual');
        return new Response(null,{status:302,headers:{Location:'https://evil.example'}});
      },
    }),/http_302/);
    assert.equal(calls,1);
    const rows=sqlite.prepare('SELECT status,error_code FROM google_search_history').all();
    assert.deepEqual(rows.map(x=>({...x})),[{status:'error',error_code:'http_302'}]);
  }finally{sqlite.close();}
});

test('Google rank collector never submits a job without a user-owned Bright Data key',async()=>{
  const statements=[];
  const env={MCP_DB:{prepare(sql){
    statements.push(sql);
    if(!sql.includes('google_search_keywords'))throw new Error('Unexpected D1 access');
    return {bind(){return {async all(){return {results:[{keyword:'test',market:'us/en',device:'desktop'}]};}};}};
  }},OAUTH_KV:mockKV()};
  const result=await runOneCollector({env,googleSub:'alice',item:{itemId:firstId},taskId:'google-search-ranking'});
  assert.deepEqual(result,{taskId:'google-search-ranking',skipped:true,
    reason:'No user-owned Bright Data key configured.'});
  assert.equal(statements.length,1);
});

test('MCP private settings app only sends Bright Data API key via tool call',()=>{
  const script=BRIGHTDATA_SETTINGS_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Script(script[1]));
  assert.match(BRIGHTDATA_SETTINGS_HTML,/type="password"/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/callTool\("set_brightdata_key"/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/callTool\("remove_brightdata_key"/);
  assert.doesNotMatch(BRIGHTDATA_SETTINGS_HTML,/localStorage|sessionStorage|innerHTML\s*=/);
});

test('Bright Data 400 diagnostic classifies input and permissions without exposing raw provider content',async()=>{
  for (const [raw,expected] of [
    ['{"error":"validation_error","message":"Input should not contain start_page"}',
      'http_400_invalid_start_page'],
    ['{"error":"validation_error","message":"Invalid country value"}',
      'http_400_invalid_country'],
    ['{"error":"account does not have permission for scraper"}',
      'http_400_access_denied'],
    ['{"error":"insufficient credits for plan"}','http_400_billing'],
    ['{"error":"unknown","secret":"BRIGHT_PRIVATE_TOKEN"}','http_400'],
  ]) {
    const result=await sanitizedHttpError(new Response(raw,{status:400}));
    assert.equal(result.message,expected);
    assert.doesNotMatch(result.message,/BRIGHT_PRIVATE_TOKEN|permission for scraper|Input should/);
  }
  assert.equal((await sanitizedHttpError(new Response(null,{status:302}))).message,'http_302');
});


test('trigger parser supports modern sd_ snapshots as well as s_ IDs and rejects untrusted values',()=>{
  assert.equal(parseSnapshotId({snapshot_id:'sd_msl80v7l1ti14rhcd6'}),'sd_msl80v7l1ti14rhcd6');
  assert.equal(parseSnapshotId({snapshot_id:'s_m4x7enmven8djfqak'}),'s_m4x7enmven8djfqak');
  assert.throws(()=>parseSnapshotId({snapshot_id:'https://evil.example/'}),/invalid_snapshot_id/);
  assert.throws(()=>parseSnapshotId({snapshot_id:'../private'}),/invalid_snapshot_id/);
  assert.throws(()=>parseSnapshotId({error:'private vendor message'}),/provider_reported_error/);
  assert.throws(()=>parseSnapshotId({data:[]}),/missing_snapshot_id/);
});

test('async trigger accepts sd_ snapshot ID, with account-bound metadata for subsequent polling',async()=>{
  const {sqlite,db}=mockD1(),kv=mockKV();
  try {
    const run=await submitBrightDataRankings({
      env:{MCP_DB:db,OAUTH_KV:kv},googleSub:'alice',item:{itemId:firstId},
      now,runId:'sd-trigger',apiKey:key,keywords:[{keyword:'provider test'}],
      request:async()=>Response.json({snapshot_id:'sd_msl80v7l1ti14rhcd6'}),
    });
    assert.equal(run.status,'pending');
    assert.equal(run.requested,1);
    const metadata=JSON.parse(kv.values.get('brightdata-job:v1:sd-trigger'));
    assert.equal(metadata.snapshotId,'sd_msl80v7l1ti14rhcd6');
  } finally {sqlite.close();}
});
