import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {
  queryAndStoreMetrics,queryAndStoreRating,queryAndStoreStatus,
  queryAndStoreReviewPage,queryAndStoreWebStoreRank,
} from "../src/query-service.js";
import {
  getRatingHistory,getStatusEvents,getWebStoreSearchSnapshots,getGoogleSearchSnapshots,
  saveGoogleSearchSnapshots,
} from "../src/collection/snapshots.js";

const id="ldpbiafkgjlaooeplkiooljccpalpkgf";
const publisherId="publisher-a";
const resource="publishers/"+publisherId+"/items/"+id;
const item={itemId:id,publisherId};
const sampleDate=Date.UTC(2026,10,4,16);

function database(){
  const sqlite=new DatabaseSync(":memory:");
  for(const file of ["schema.sql","migrations/0001_collectors.sql",
    "migrations/0002_google_search.sql","migrations/0003_reviews.sql",
    "migrations/0004_unified_queries.sql"]){
    sqlite.exec(readFileSync(new URL("../"+file,import.meta.url),"utf8"));
  }
  for(const sub of ["alice","bob"]){
    sqlite.prepare("INSERT INTO user_extensions (google_sub,item_id,publisher_id,store_url) VALUES (?,?,?,?)")
      .run(sub,id,publisherId,"https://example.invalid/extension");
  }
  const db={
    prepare(sql){return {bind(...args){
      const stmt=sqlite.prepare(sql);
      return {
        async first(){return stmt.get(...args)??null;},
        async all(){return {results:stmt.all(...args)};},
        async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};},
      };
    }};},
    async batch(statements){
      sqlite.exec("BEGIN");
      try{
        const result=[];
        for(const stmt of statements)result.push(await stmt.run());
        sqlite.exec("COMMIT");return result;
      }catch(error){sqlite.exec("ROLLBACK");throw error;}
    },
  };
  return {db,sqlite};
}

test("live metrics store all 521 rows even though MCP returns at most 500",async()=>{
  const {db,sqlite}=database();
  try{
    const rows=Array.from({length:521},(_,i)=>({
      date:{year:2026,month:11,day:3},dimensionValues:["country-"+i],
      metricValues:[{metric:"installs",value:"1"}],
    }));
    const result=await queryAndStoreMetrics({
      db,googleSub:"alice",item,metric:"installs",dimension:"country",days:2,
      token:"dummy",request:async()=>Response.json({metricRows:rows}),
    });
    assert.equal(result.rows.length,500);
    assert.equal(result.totalRows,521);
    assert.equal(result.truncated,true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM metric_history WHERE google_sub='alice'").get().n,521);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM metric_history WHERE google_sub='bob'").get().n,0);
  }finally{sqlite.close();}
});

test("rating snapshots upsert by day, remain account scoped and preserve int64s",async()=>{
  const {db,sqlite}=database();
  try{
    for(const [rating,account]of [[4.3,"alice"],[4.9,"alice"],[3.1,"bob"]]){
      await queryAndStoreRating({
        db,googleSub:account,item,token:"dummy",now:sampleDate,
        request:async()=>Response.json({name:resource+"/ratingSummary",
          rating,ratingCount:"9007199254740993"}),
      });
    }
    const history=await getRatingHistory(db,"alice",id,365);
    assert.equal(history.length,1);
    assert.equal(history[0].summary.rating,4.9);
    assert.equal(history[0].summary.ratingCount,"9007199254740993");
    assert.equal((await getRatingHistory(db,"bob",id,365))[0].summary.rating,3.1);
  }finally{sqlite.close();}
});

test("status events only add new changes and do not mix accounts",async()=>{
  const {db,sqlite}=database();
  try{
    for(const phase of ["PUBLISHED","PUBLISHED","IN_REVIEW"]){
      await queryAndStoreStatus({db,googleSub:"alice",item,token:"dummy",
        request:async()=>Response.json({name:resource,
          publishedItemRevisionStatus:{state:phase}})});
    }
    assert.equal((await getStatusEvents(db,"alice",id)).length,2);
    assert.equal((await getStatusEvents(db,"bob",id)).length,0);
  }finally{sqlite.close();}
});

test("live reviews persist before returning, even when daily cron is disabled",async()=>{
  const {db,sqlite}=database();
  try{
    const review={name:"reviews/test",item:resource,comment:"Good",
      rating:4,createTime:"2026-11-03T18:00:00Z"};
    const result=await queryAndStoreReviewPage({db,googleSub:"alice",item,
      token:"dummy",pageSize:50,rating:4,
      request:async()=>Response.json({reviews:[review]})});
    assert.equal(result.persisted.newReviews,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM review_history WHERE google_sub='alice'").get().n,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM review_history WHERE google_sub='bob'").get().n,0);
  }finally{sqlite.close();}
});

test("webstore ranked search snapshots retain every returned result, not only our rank",async()=>{
  const {db,sqlite}=database();
  try{
    const another="abcdefghijklmnopabcdefghijklmnop";
    const raw=JSON.stringify([[[[[[id,"icon","Ours"],[another,"icon2","Other"]]]]]]);
    const envelope=JSON.stringify([["wrb.fr","zTyKYc",raw,null]]);
    let calls=0;
    const result=await queryAndStoreWebStoreRank({db,googleSub:"alice",item,
      keyword:"gemini exporter",request:async()=>{
        calls++;
        return calls===1?
          new Response("boq_chrome-webstore-consumerfe-ui_20261104.00_p0"):
          new Response(")]}'\\n\\n"+envelope.length+"\\n"+envelope);
      }});
    assert.equal(calls,2);
    assert.equal(result.rank,1);
    const history=await getWebStoreSearchSnapshots(db,"alice",id,365);
    assert.equal(history.length,1);
    assert.equal(history[0].results.length,2); // retain other extensions in the search results
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM webstore_search_snapshots WHERE google_sub='bob'").get().n,0);
  }finally{sqlite.close();}
});

test("full Bright Data records are stored without leaking between users",async()=>{
  const {db,sqlite}=database();
  try{
    const payload={keyword:"gemini exporter",organic:[
      {title:"unrelated",link:"https://example.com",position:1},
      {title:"our extension",link:"https://chromewebstore.google.com/detail/"+id,position:2},
    ],metadata:{query:"gemini exporter"}};
    await saveGoogleSearchSnapshots(db,"alice",id,"2026-11-04","sd_test-123",
      [{keyword:"gemini exporter",market:"us/en",device:"desktop",payload}]);
    const results=await getGoogleSearchSnapshots(db,"alice",id,365);
    assert.equal(results.length,1);
    assert.deepEqual(results[0].payload,payload);
    assert.deepEqual(await getGoogleSearchSnapshots(db,"bob",id,365),[]);
    sqlite.prepare("DELETE FROM user_extensions WHERE google_sub=? AND item_id=?").run("alice",id);
    assert.deepEqual(await getGoogleSearchSnapshots(db,"alice",id,365),[]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM google_search_snapshots").get().n,0);
  }finally{sqlite.close();}
});

test("a failed D1 write does not report an external query as successful",async()=>{
  const {db,sqlite}=database();
  try{
    const failingDb={prepare(sql){
      if (sql.includes("INSERT INTO rating_history"))throw new Error("D1 unavailable");
      return db.prepare(sql);
    }};
    await assert.rejects(queryAndStoreRating({
      db:failingDb,googleSub:"alice",item,token:"dummy",
      request:async()=>Response.json({name:resource+"/ratingSummary",rating:4.3}),
    }),/D1 unavailable/);
  }finally{sqlite.close();}
});
