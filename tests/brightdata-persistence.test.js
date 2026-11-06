import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {submitBrightDataRankings,pollBrightDataRun} from "../src/collection/brightdata.js";

const itemId="ldpbiafkgjlaooeplkiooljccpalpkgf";
const now=Date.UTC(2026,10,4,16);
const runId="test-brightdata-e2e";

function setup(){
  const sqlite=new DatabaseSync(":memory:");
  for(const path of ["schema.sql","migrations/0001_collectors.sql",
    "migrations/0002_google_search.sql","migrations/0004_unified_queries.sql"]){
    sqlite.exec(readFileSync(new URL("../"+path,import.meta.url),"utf8"));
  }
  sqlite.prepare("INSERT INTO user_extensions (google_sub,item_id,publisher_id,store_url) VALUES (?,?,?,?)")
    .run("alice",itemId,"publisher-a","https://example.test/extension");
  sqlite.prepare("INSERT INTO collector_runs (run_id,google_sub,item_id,task_id,date,trigger_kind,status) VALUES (?,?,?,?,?,'manual','running')")
    .run(runId,"alice",itemId,"google-search-ranking","2026-11-04");
  const db={
    prepare(sql){return {bind(...args){const stmt=sqlite.prepare(sql);return {
      async first(){return stmt.get(...args)??null;},
      async all(){return {results:stmt.all(...args)};},
      async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};},
    };}};},
    async batch(statements){
      sqlite.exec("BEGIN");
      try{const values=[];for(const s of statements)values.push(await s.run());sqlite.exec("COMMIT");return values;}
      catch(err){sqlite.exec("ROLLBACK");throw err;}
    },
  };
  const kvValues=new Map();
  const kv={async put(k,v){kvValues.set(k,v);},async get(k,kind){
    const value=kvValues.get(k);return kind==="json" && value ? JSON.parse(value) : value??null;
  },async delete(k){kvValues.delete(k);}};
  return {db,sqlite,kv,kvValues};
}

test("Bright Data only acknowledges a result after the entire organic record is stored",async()=>{
  const {db,sqlite,kv,kvValues}=setup();
  try{
    const env={MCP_DB:db,OAUTH_KV:kv};
    const keywords=[{keyword:"gemini exporter",market:"us/en",device:"desktop"}];
    const submitted=await submitBrightDataRankings({
      env,googleSub:"alice",item:{itemId},runId,now,keywords,apiKey:"fixture",
      request:async()=>Response.json({snapshot_id:"sd_example123"}),
    });
    assert.equal(submitted.status,"pending");
    const providerRecord={keyword:"gemini exporter",organic:[
      {position:1,title:"Other",link:"https://example.test/other",description:"first result"},
      {position:2,title:"Our extension",link:"https://chromewebstore.google.com/detail/"+itemId},
    ],extraMetadata:{domain:"google.com",total:2}};
    const request=async url=>url.includes("/progress/") ?
      Response.json({status:"ready"}) : Response.json([providerRecord]);
    const failingDb={...db,prepare(sql){
      if(sql.includes("INSERT INTO google_search_snapshots"))throw new Error("D1 temporarily unavailable");
      return db.prepare(sql);
    }};
    await assert.rejects(pollBrightDataRun({env:{...env,MCP_DB:failingDb},
      googleSub:"alice",itemId,runId,apiKey:"fixture",request}),/brightdata_poll_failed_snapshot_persist/);
    assert.equal(kvValues.has("brightdata-job:v1:"+runId),true);
    assert.equal(sqlite.prepare("SELECT status FROM google_search_history").get().status,"pending");
    assert.equal(sqlite.prepare("SELECT status FROM collector_runs").get().status,"running");

    const finished=await pollBrightDataRun({env,googleSub:"alice",itemId,
      runId,apiKey:"fixture",request});
    assert.equal(finished.status,"succeeded");
    const snapshot=sqlite.prepare("SELECT payload_json AS payload FROM google_search_snapshots WHERE google_sub='alice'").get();
    assert.deepEqual(JSON.parse(snapshot.payload),providerRecord);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM google_search_snapshots WHERE google_sub='bob'").get().n,0);
    assert.equal(sqlite.prepare("SELECT status FROM collector_runs").get().status,"succeeded");
    assert.equal(kvValues.size,0);
  }finally{sqlite.close();}
});
