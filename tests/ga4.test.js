import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGa4Range,parseGa4Reports,fetchGa4Reports,persistGa4Reports } from '../src/collection/ga4.js';
import { dueGa4Range } from '../src/collection/ga4-schedule.js';

const row=(date,values,extra=[])=>({
  dimensionValues:[{value:date.replaceAll('-','')},...extra.map(value=>({value}))],
  metricValues:values.map(value=>({value:String(value)})),
});
test('GA4 dates reject malformed or overly long reporting ranges',()=>{
  assert.doesNotThrow(()=>validateGa4Range('2026-10-29','2026-11-06'));
  for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-11-07','2026-11-06'],
    ['2026-01-01','2026-11-01']]){
    assert.throws(()=>validateGa4Range(from,to));
  }
});
test('GA4 totals, install events and channels are independent, with no invented zeroes',()=>{
  const reports=parseGa4Reports({
    dateFrom:'2026-11-05',dateTo:'2026-11-06',
    total:[row('2026-11-05',[4,7,7]),row('2026-11-06',[7,10,13])],
    installs:[row('2026-11-06',[4])],
    channels:[row('2026-11-06',[2,1],['google / organic'])],
  });
  assert.equal(reports.daily[0].installEvents,null);
  assert.deepEqual(reports.daily[1],{
    date:'2026-11-06',activeUsers:7,sessions:10,pageViews:13,installEvents:4,
  });
  assert.equal(reports.channels[0].sourceMedium,'google / organic');
  assert.throws(()=>parseGa4Reports({dateFrom:'2026-11-06',dateTo:'2026-11-06',
    total:[],installs:[],channels:[]}),/no daily data/);
});
test('GA4 uses official v1beta reports with least required dimensions and filter',async()=>{
  const requests=[];
  const data=await fetchGa4Reports({propertyId:'551943445',accessToken:'secret',
    dateFrom:'2026-11-05',dateTo:'2026-11-06',request:async(url,options)=>{
      requests.push({url,options,body:JSON.parse(options.body)});
      const b=JSON.parse(options.body),metrics=b.metrics.map(m=>m.name);
      const rows=metrics.includes('screenPageViews')?[row('2026-11-06',[7,10,13])]:
        metrics.includes('eventCount')?[row('2026-11-06',[4])]:
        [row('2026-11-06',[2,1],['reddit / social'])];
      return Response.json({rowCount:rows.length,rows});
    }});
  assert.equal(requests.length,3);
  assert.ok(requests.every(x=>x.url==='https://analyticsdata.googleapis.com/v1beta/properties/551943445:runReport'));
  assert.ok(requests.every(x=>x.options.headers.Authorization==='Bearer secret'));
  assert.equal(requests[1].body.dimensionFilter.filter.fieldName,'eventName');
  assert.equal(requests[1].body.dimensionFilter.filter.stringFilter.value,'install');
  assert.equal(data.daily[0].installEvents,4);
  assert.equal(data.channels[0].sourceMedium,'reddit / social');
});
test('GA4 propagates authorization denial without saving an empty report',async()=>{
  await assert.rejects(fetchGa4Reports({propertyId:'551943445',accessToken:'bad',
    dateFrom:'2026-11-06',dateTo:'2026-11-06',
    request:async()=>new Response('',{status:403})}),/permission denied/);
});
test('D1 uses a transactional batch, bounded bulk inserts, source ID and date range',async()=>{
  const calls=[];
  const db={prepare(sql){return{bind(...params){return{sql,params}}}},
    async batch(statements){calls.push(statements);return statements.map(()=>({success:true}));}};
  const daily=[{date:'2026-11-06',activeUsers:7,sessions:10,pageViews:13,installEvents:4}];
  const channels=Array.from({length:50},(_,i)=>({
    date:'2026-11-06',sourceMedium:'source-'+i,sessions:1,activeUsers:1,
  }));
  const n=await persistGa4Reports(db,{sourceId:'source-a',dateFrom:'2026-11-06',
    dateTo:'2026-11-06',daily,channels});
  assert.equal(n,51);
  assert.equal(calls[0].length,5);
  assert.match(calls[0][0].sql,/DELETE FROM ga4_daily_history/);
  assert.match(calls[0][1].sql,/DELETE FROM ga4_channel_history/);
  assert.ok(calls[0].every(x=>x.params[0]==='source-a'));
});
test('GA4 schedule is DST-safe and independent from existing CWS hours',()=>{
  assert.deepEqual(dueGa4Range(Date.UTC(2026,10,7,17)),
    {dateFrom:'2026-10-31',dateTo:'2026-11-06'});
  assert.deepEqual(dueGa4Range(Date.UTC(2026,6,7,16)),
    {dateFrom:'2026-06-30',dateTo:'2026-07-06'});
  assert.equal(dueGa4Range(Date.UTC(2026,10,7,16)),null);
});
