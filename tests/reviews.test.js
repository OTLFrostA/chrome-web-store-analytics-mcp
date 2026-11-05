import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {fetchReviewPage, normalizeReview, collectReviews, saveReviewPage,
  getSavedReviews, getReviewSettings, setReviewSettings} from '../src/collection/reviews.js';
import {deleteAccountHistory,deleteExtensionHistory} from '../src/collection/history.js';
import {dueCollectorIds,runOneCollector} from '../src/collection/runner.js';

const itemId='ldpbiafkgjlaooeplkiooljccpalpkgf';
const publisherId='sample-publisher';
const first=(id='one',rating=5,comment='Super helpful')=>({
  name:'reviews/'+id,item:'publishers/'+publisherId+'/items/'+itemId,
  authorInfo:{displayName:'Reviewer '+id},rating,comment,
  createTime:'2026-11-04T09:03:22Z',
});
function mockD1() {
  const sqlite=new DatabaseSync(':memory:');
  for(const p of ['schema.sql','migrations/0001_collectors.sql',
    'migrations/0002_google_search.sql','migrations/0003_reviews.sql']){
    sqlite.exec(readFileSync(new URL('../'+p,import.meta.url),'utf8'));
  }
  const db={
    prepare(sql){return {bind(...values){
      const statement=sqlite.prepare(sql);
      return {
        async first(){return statement.get(...values)??null;},
        async all(){return {results:statement.all(...values)};},
        async run(){return {meta:{changes:Number(statement.run(...values).changes)}};},
      };
    }};},
    async batch(statements){
      sqlite.exec('BEGIN');
      try{const results=[];
        for(const stmt of statements)results.push(await stmt.run());
        sqlite.exec('COMMIT');return results;
      }catch(e){sqlite.exec('ROLLBACK');throw e;}
    },
  };
  return {db,sqlite};
}

test('review API uses official OAuth origin, descending order, 200-page limit and protected pagination',async()=>{
  const requests=[];
  const request=async(url,options)=>{
    requests.push({url:new URL(url),options});
    return Response.json({reviews:[first('new')],nextPageToken:'next-page'});
  };
  const page=await fetchReviewPage('access-token',publisherId,itemId,'previous-page',request);
  assert.equal(page.reviews.length,1);
  assert.equal(page.reviews[0].reviewName,'reviews/new');
  assert.equal(page.reviews[0].createTime,'2026-11-04T09:03:22.000Z');
  assert.equal(page.nextPageToken,'next-page');
  assert.equal(requests[0].url.hostname,'chromewebstore.googleapis.com');
  assert.match(requests[0].url.pathname,/fetchReviews$/);
  assert.equal(requests[0].url.searchParams.get('pageSize'),'200');
  assert.equal(requests[0].url.searchParams.get('orderBy'),'create_time desc');
  assert.equal(requests[0].url.searchParams.get('pageToken'),'previous-page');
  assert.equal(requests[0].options.redirect,'manual');
  assert.equal(requests[0].options.headers.Authorization,'Bearer access-token');
});

test('review normalization rejects cross-extension data, invalid shapes and oversized content',()=>{
  assert.equal(normalizeReview(first(),publisherId,itemId).rating,5);
  for(const invalid of [
    {...first(),item:'publishers/other/items/'+itemId},
    {...first(),name:'../../bad'},
    {...first(),rating:0},
    {...first(),rating:6},
    {...first(),comment:{text:'unexpected'}},
    {...first(),createTime:'not a date'},
    {...first(),comment:'a'.repeat(20001)},
    {...first(),authorInfo:{displayName:42}},
  ])assert.throws(()=>normalizeReview(invalid,publisherId,itemId));
});

test('config is scoped per account and extension; disable does not delete saved reviews',async()=>{
  const {db,sqlite}=mockD1();
  try{
    assert.deepEqual(await getReviewSettings(db,'alice',itemId),{enabled:true,maxPages:5});
    assert.deepEqual(await setReviewSettings(db,'alice',itemId,{enabled:false,maxPages:2}),
      {enabled:false,maxPages:2});
    assert.deepEqual(await setReviewSettings(db,'alice',itemId,{enabled:true}),
      {enabled:true,maxPages:2});
    assert.deepEqual(await getReviewSettings(db,'bob',itemId),{enabled:true,maxPages:5});
    assert.deepEqual(await getReviewSettings(db,'alice','other'),{enabled:true,maxPages:5});
    await assert.rejects(setReviewSettings(db,'alice',itemId,{maxPages:11}),/page limit/);
    const result=await saveReviewPage(db,'alice',itemId,[
      normalizeReview(first(),publisherId,itemId),
    ]);
    assert.equal(result.newReviews,1);
    await setReviewSettings(db,'alice',itemId,{enabled:false});
    assert.equal((await getSavedReviews(db,'alice',itemId)).length,1);
    assert.deepEqual(await getSavedReviews(db,'bob',itemId),[]);
  }finally{sqlite.close();}
});

test('official collector fetches multiple pages, deduplicates, updates edits, and limits repeated calls',async()=>{
  const {db,sqlite}=mockD1();
  try{
    const env={MCP_DB:db,GOOGLE_API_RATE_LIMITER:{async limit(){return {success:true};}}};
    const calls=[];
    const request=async(url)=>{
      const path=new URL(url);
      calls.push(path.toString());
      if(path.hostname==='oauth2.googleapis.com')return Response.json({access_token:'oauth-token'});
      if(path.searchParams.get('pageToken')==='next')return Response.json({reviews:[first('two',4,'Great!')]});
      return Response.json({reviews:[first('one',5)],nextPageToken:'next'});
    };
    const args={env,googleSub:'alice',item:{itemId,publisherId},
      refreshToken:'oauth-refresh',request,paceMs:0};
    const collected=await collectReviews(args);
    assert.deepEqual({fetched:collected.fetched,newReviews:collected.newReviews,pagesFetched:collected.pagesFetched,truncated:collected.truncated},
      {fetched:2,newReviews:2,pagesFetched:2,truncated:false});
    assert.equal((await getSavedReviews(db,'alice',itemId)).length,2);
    assert.equal((await getSavedReviews(db,'bob',itemId)).length,0);
    const again=await collectReviews({...args,request:async url=>{
      const path=new URL(url);
      if(path.hostname==='oauth2.googleapis.com')return Response.json({access_token:'oauth-token'});
      if(path.searchParams.get('pageToken')==='next')return Response.json({reviews:[first('two',3,'Changed opinion')]});
      return Response.json({reviews:[first('one',5)],nextPageToken:'next'});
    }});
    assert.equal(again.newReviews,0);
    assert.equal(again.updatedReviews,2);
    const revised=(await getSavedReviews(db,'alice',itemId)).find(x=>x.reviewName==='reviews/two');
    assert.equal(revised.rating,3);
    assert.equal(revised.comment,'Changed opinion');
    assert.equal(calls.filter(x=>x.includes('fetchReviews')).length,2);
  }finally{sqlite.close();}
});

test('review fetch respects max pages, rejects repeated pagination and never treats a 403 as no reviews',async()=>{
  const {db,sqlite}=mockD1();
  try {
    const env={MCP_DB:db,GOOGLE_API_RATE_LIMITER:{async limit(){return {success:true};}}};
    const req=async url=>new URL(url).hostname==='oauth2.googleapis.com'
      ? Response.json({access_token:'x'}) : Response.json({reviews:[first()],nextPageToken:'more'});
    await setReviewSettings(db,'alice',itemId,{maxPages:1});
    const run=await collectReviews({env,googleSub:'alice',item:{itemId,publisherId},
      refreshToken:'refresh',request:req,paceMs:0});
    assert.equal(run.truncated,true);
    assert.equal(run.pagesFetched,1);
    assert.equal(run.newReviews,1);
    await setReviewSettings(db,'alice',itemId,{maxPages:4});
    await assert.rejects(collectReviews({env,googleSub:'alice',
      item:{itemId,publisherId},refreshToken:'refresh',request:req,paceMs:0}),
      /repeated a token/);
    await assert.rejects(fetchReviewPage('x',publisherId,itemId,null,
      async()=>new Response('Forbidden: google user data',{status:403})),/HTTP 403/);
    assert.equal((await getSavedReviews(db,'alice',itemId)).length,1);
  }finally{sqlite.close();}
});

test('new review tool is independently scheduled at 9 AM Pacific, and disabled runs do not claim a day',async()=>{
  assert.deepEqual(dueCollectorIds(Date.UTC(2026,10,4,17)),['cws-reviews','cws-metadata']);
  assert.deepEqual(dueCollectorIds(Date.UTC(2026,6,4,16)),['cws-reviews','cws-metadata']);
  assert.deepEqual(dueCollectorIds(Date.UTC(2026,10,4,16)),
    ['cws-analytics','cws-ranking','google-search-ranking']);
  const {db,sqlite}=mockD1();
  try{
    await setReviewSettings(db,'alice',itemId,{enabled:false});
    const result=await runOneCollector({env:{MCP_DB:db},googleSub:'alice',
      item:{itemId,publisherId},taskId:'cws-reviews'});
    assert.equal(result.skipped,true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM collector_runs WHERE task_id='cws-reviews'").get().n,0);
  }finally{sqlite.close();}
});

test('unlink and account deletion clean up private review rows and settings without affecting other accounts',async()=>{
  const {db,sqlite}=mockD1();
  try{
    for(const account of ['alice','bob']){
      await saveReviewPage(db,account,itemId,[normalizeReview(first(),publisherId,itemId)]);
      await setReviewSettings(db,account,itemId,{enabled:false});
    }
    await deleteExtensionHistory(db,'alice',itemId);
    assert.deepEqual(await getSavedReviews(db,'alice',itemId),[]);
    assert.equal((await getSavedReviews(db,'bob',itemId)).length,1);
    await deleteAccountHistory(db,'bob');
    assert.deepEqual(await getSavedReviews(db,'bob',itemId),[]);
    assert.deepEqual(await getReviewSettings(db,'bob',itemId),{enabled:true,maxPages:5});
  }finally{sqlite.close();}
});


test('review collector retries legacy camelCase ordering only after a first-page HTTP 400',async()=>{
  const {db,sqlite}=mockD1();
  try{
    const requested=[];
    const env={MCP_DB:db,GOOGLE_API_RATE_LIMITER:{async limit(){return {success:true};}}};
    const request=async url=>{
      const parsed=new URL(url);
      if(parsed.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access-token'});
      requested.push(parsed.searchParams.get('orderBy'));
      if(requested.length===1)return new Response('invalid orderBy create_time: secret user value',{status:400});
      if(requested.length===2)return Response.json({reviews:[first('one')],nextPageToken:'p2'});
      return Response.json({reviews:[first('two')]});
    };
    const result=await collectReviews({env,googleSub:'alice',item:{itemId,publisherId},
      refreshToken:'oauth-refresh',request,paceMs:0});
    assert.equal(result.newReviews,2);
    assert.deepEqual(requested,['create_time desc','createTime desc','createTime desc']);
  }finally{sqlite.close();}
});

test('a provider 400 diagnostic only exposes fixed reason codes, never response text or secrets',async()=>{
  const err=await assert.rejects(fetchReviewPage('token',publisherId,itemId,null,
    async()=>new Response('Bad orderBy: secret publisher123 and oauth-token',{status:400})),/HTTP 400_invalid_order/);
  const responseBody='permission denied, token sensitive-key';
  await assert.rejects(fetchReviewPage('token',publisherId,itemId,null,
    async()=>new Response(responseBody,{status:400})),/HTTP 400/);
  await assert.rejects(fetchReviewPage('token',publisherId,itemId,null,
    async()=>new Response('unsupported pageSize: private info',{status:400})),/HTTP 400_invalid_pagination/);
});

