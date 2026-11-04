import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {readKeywordSettings,saveKeywordSettings,validateKeywordSettings} from '../src/collection/keyword-settings.js';
import {listGoogleSearchKeywords} from '../src/collection/brightdata.js';
import {BRIGHTDATA_SETTINGS_HTML,BRIGHTDATA_SETTINGS_URI} from '../src/brightdata-setup-ui.js';

const first='ldpbiafkgjlaooeplkiooljccpalpkgf';
const second='jfepajhaapfonhhfjmamediilplchakk';

function database() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_collectors.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_google_search.sql',import.meta.url),'utf8'));
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
      try{
        const results=[];
        for(const stmt of statements)results.push(await stmt.run());
        sqlite.exec('COMMIT');return results;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return {sqlite,db};
}

test('keyword lists are absent until user explicitly configures them',async()=>{
  const {sqlite,db}=database();
  try{
    assert.deepEqual(await readKeywordSettings(db,'alice',first),{google:[],webstore:[]});
    assert.deepEqual(await readKeywordSettings(db,'bob',first),{google:[],webstore:[]});
  }finally{sqlite.close();}
});

test('read, add, pause, resume, remove are account/extension scoped across both sources',async()=>{
  const {sqlite,db}=database();
  try{
    const input=[
      {keyword:'Gemini Exporter',enabled:true},
      {keyword:'bulk export gemini',enabled:false},
    ];
    assert.deepEqual(await saveKeywordSettings(db,'alice',first,'google',input),input);
    assert.deepEqual(await saveKeywordSettings(db,'alice',first,'webstore',[
      {keyword:'gemini exporter',enabled:true},
      {keyword:'bulk export',enabled:false},
    ]),[
      {keyword:'gemini exporter',enabled:true},
      {keyword:'bulk export',enabled:false},
    ]);
    assert.deepEqual(await readKeywordSettings(db,'bob',first),{google:[],webstore:[]});
    assert.deepEqual(await readKeywordSettings(db,'alice',second),{google:[],webstore:[]});
    const before=await readKeywordSettings(db,'alice',first);
    assert.equal(before.google.length,2);
    assert.equal(before.webstore.length,2);
    assert.equal(before.google.find(x=>x.keyword==='bulk export gemini').enabled,false);
    assert.deepEqual((await listGoogleSearchKeywords(db,'alice',first)).map(x=>x.keyword),
      ['Gemini Exporter']);
    // Disabling Google keywords never affects the independent CWS rankings.
    const allPaused=before.google.map(x=>({...x,enabled:false}));
    await saveKeywordSettings(db,'alice',first,'google',allPaused);
    assert.deepEqual(await listGoogleSearchKeywords(db,'alice',first),[]);
    assert.equal((await readKeywordSettings(db,'alice',first)).webstore.length,2);
    // Restore one Google keyword. The other remains safely paused.
    await saveKeywordSettings(db,'alice',first,'google',[
      {keyword:'Gemini Exporter',enabled:true},
      {keyword:'bulk export gemini',enabled:false},
    ]);
    assert.deepEqual((await listGoogleSearchKeywords(db,'alice',first)).map(x=>x.keyword),
      ['Gemini Exporter']);
    // CWS collection uses enabled=1, not deleted keywords.
    const activeWebStore=sqlite.prepare(
      'SELECT keyword FROM collector_keywords WHERE google_sub=? AND item_id=? AND enabled=1')
      .all('alice',first);
    assert.deepEqual(activeWebStore.map(x=>x.keyword),['gemini exporter']);
    // Removal is a settings change only; another user and extension stay intact.
    await saveKeywordSettings(db,'alice',first,'webstore',[]);
    assert.equal((await readKeywordSettings(db,'alice',first)).webstore.length,0);
    assert.equal((await readKeywordSettings(db,'alice',first)).google.length,2);
  }finally{sqlite.close();}
});

test('editing or deleting keyword settings never removes existing ranking history',async()=>{
  const {sqlite,db}=database();
  try{
    sqlite.prepare("INSERT INTO google_search_history " +
      "(google_sub,item_id,date,keyword,market,device,status,rank) " +
      "VALUES (?,?,?,'gemini exporter','us/en','desktop','found',3)")
      .run('alice',first,'2026-11-01');
    await saveKeywordSettings(db,'alice',first,'google',[
      {keyword:'gemini exporter',enabled:false},
    ]);
    await saveKeywordSettings(db,'alice',first,'google',[]);
    const saved=sqlite.prepare('SELECT keyword,status,rank FROM google_search_history WHERE google_sub=?')
      .all('alice');
    assert.deepEqual(saved.map(x=>({...x})),[
      {keyword:'gemini exporter',status:'found',rank:3},
    ]);
  }finally{sqlite.close();}
});

test('validation enforces both per-engine limits and forbids duplicate/invalid settings before D1 writes',async()=>{
  const {sqlite,db}=database();
  try{
    assert.equal(validateKeywordSettings('google',Array.from({length:100},(_,i)=>({
      keyword:'keyword '+i,enabled:i%2===0,
    }))).length,100);
    assert.throws(()=>validateKeywordSettings('google',Array.from({length:101},(_,i)=>({
      keyword:'keyword '+i,enabled:true,
    }))),/at most 100/);
    assert.throws(()=>validateKeywordSettings('webstore',Array.from({length:21},(_,i)=>({
      keyword:'keyword '+i,enabled:true,
    }))),/at most 20/);
    assert.throws(()=>validateKeywordSettings('invalid',[]),/Unsupported/);
    assert.throws(()=>validateKeywordSettings('google',[
      {keyword:'Gemini Exporter',enabled:true},
      {keyword:' gemini exporter ',enabled:false},
    ]),/Duplicate/);
    assert.throws(()=>validateKeywordSettings('google',[{keyword:' ',enabled:true}]),/1 and 120/);
    assert.throws(()=>validateKeywordSettings('google',[{keyword:'valid',enabled:1}]),/enabled boolean/);
    assert.throws(()=>validateKeywordSettings('google',[{keyword:'x'.repeat(121),enabled:true}]),/1 and 120/);
    await assert.rejects(saveKeywordSettings(db,'alice',first,'google',[
      {keyword:'bad',enabled:true},{keyword:'BAD',enabled:false},
    ]),/Duplicate/);
    assert.deepEqual(await readKeywordSettings(db,'alice',first),{google:[],webstore:[]});
  }finally{sqlite.close();}
});

test('unified private settings UI renders both keyword editors with safe MCP tool calls',()=>{
  assert.match(BRIGHTDATA_SETTINGS_URI,/brightdata-settings-v2\.html$/);
  const script=BRIGHTDATA_SETTINGS_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Script(script[1]));
  for(const tool of ['list_extensions','get_keyword_settings','save_keyword_settings',
    'get_brightdata_status','set_brightdata_key','remove_brightdata_key']){
    assert.ok(BRIGHTDATA_SETTINGS_HTML.includes('callTool("'+tool+'"'),tool);
  }
  for(const id of ['extension','google-list','webstore-list','google-form','webstore-form']){
    assert.match(BRIGHTDATA_SETTINGS_HTML,new RegExp('id="'+id+'"'));
  }
  assert.match(BRIGHTDATA_SETTINGS_HTML,/type="checkbox"/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/toggle\.type="checkbox"/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/type="password"/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/textContent/);
  assert.doesNotMatch(BRIGHTDATA_SETTINGS_HTML,/innerHTML\s*=|localStorage|sessionStorage|eval\(/);
  assert.match(BRIGHTDATA_SETTINGS_HTML,/keywordData\[source\]=response\.entries/);
});
