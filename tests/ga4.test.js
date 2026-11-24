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
  assert.deepEqual(parseGa4Reports({dateFrom:'2026-11-06',dateTo:'2026-11-06',
    total:[],installs:[],channels:[]}),{daily:[],channels:[]});
  assert.throws(()=>parseGa4Reports({dateFrom:'2026-11-06',dateTo:'2026-11-06',
    total:[],installs:[row('2026-11-06',[1])],channels:[]}),/without daily GA4 coverage/);
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
function emptyReport(body){
  return {kind:'analyticsData#runReport',dimensionHeaders:body.dimensions,
    metricHeaders:body.metrics,metadata:{}};
}
test('GA4 accepts a genuine empty protobuf report and keeps missing installs null',async()=>{
  const params={propertyId:'551943445',accessToken:'token',
    dateFrom:'2026-11-06',dateTo:'2026-11-06'};
  const empty=await fetchGa4Reports({...params,request:async(url,options)=>
    Response.json(emptyReport(JSON.parse(options.body)))});
  assert.deepEqual(empty,{daily:[],channels:[]});
  const mixed=await fetchGa4Reports({...params,request:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(body.metrics.some(m=>m.name==='screenPageViews'))
      return Response.json({rows:[row('2026-11-06',[7,10,13])],rowCount:1});
    return Response.json(emptyReport(body));
  }});
  assert.deepEqual(mixed,{daily:[{date:'2026-11-06',activeUsers:7,sessions:10,
    pageViews:13,installEvents:null}],channels:[]});
});
test('GA4 rejects malformed and incomplete empty responses rather than losing data',async()=>{
  const params={propertyId:'551943445',accessToken:'token',
    dateFrom:'2026-11-06',dateTo:'2026-11-06'};
  for(const response of [{},{rows:null,rowCount:0},{rowCount:2},
    {kind:'analyticsData#runReport'}, {error:{message:'bad'},rowCount:0}]){
    await assert.rejects(fetchGa4Reports({...params,request:async()=>Response.json(response)}),
      /Invalid GA4 report response|no valid rows array/);
  }
  await assert.rejects(fetchGa4Reports({...params,request:async(url,options)=>{
    const body=JSON.parse(options.body);
    return Response.json({...emptyReport(body),rows:[],rowCount:2});
  }}),/pagination was incomplete/);
});
test('Empty GA4 persistence never deletes history or invents zeroes',async()=>{
  const db={prepare(){assert.fail('empty reports must not prepare SQL');},
    batch(){assert.fail('empty reports must not write');}};
  const args={sourceId:'source-a',dateFrom:'2026-11-06',dateTo:'2026-11-06',daily:[],channels:[]};
  assert.equal(await persistGa4Reports(db,args),0);
  await assert.rejects(persistGa4Reports(db,{...args,channels:[{date:'2026-11-06'}]}),
    /without daily coverage/);
});
for(const [dayCount,channelsPerDay] of [[1,50],[7,6],[90,6]]){
  test('D1 GA4 writes '+dayCount+' days atomically with at most 100 SQL parameters',async()=>{
    const calls=[];
    const db={prepare(sql){return{bind(...params){
      assert.ok(params.length<=100,'D1 rejects more than 100 bound parameters');
      assert.equal((sql.match(/\?/g)??[]).length,params.length);
      return{sql,params};
    }}},async batch(statements){calls.push(statements);return statements.map(()=>({success:true}));}};
    const daily=Array.from({length:dayCount},(_,i)=>({
      date:new Date(Date.UTC(2026,7,1+i)).toISOString().slice(0,10),
      activeUsers:7,sessions:10,pageViews:13,installEvents:i===0?null:4,
    }));
    const channels=daily.flatMap(day=>Array.from({length:channelsPerDay},(_,i)=>({
      date:day.date,sourceMedium:'source-'+i,sessions:1,activeUsers:1,
    })));
    const n=await persistGa4Reports(db,{sourceId:'source-a',dateFrom:daily[0].date,
      dateTo:daily.at(-1).date,daily,channels});
    assert.equal(n,daily.length+channels.length);
    assert.equal(calls.length,1,'replacement remains a single transactional batch');
    const statements=calls[0];
    assert.match(statements[0].sql,/DELETE FROM ga4_daily_history/);
    assert.match(statements[1].sql,/DELETE FROM ga4_channel_history/);
    for(const stmt of statements.slice(0,2))
      assert.deepEqual(stmt.params,['source-a',...daily.map(day=>day.date)]);
    const dailyInserts=statements.filter(x=>x.sql.startsWith('INSERT INTO ga4_daily_history'));
    const channelInserts=statements.filter(x=>x.sql.startsWith('INSERT INTO ga4_channel_history'));
    assert.deepEqual(dailyInserts.flatMap(x=>x.params),daily.flatMap(day=>
      ['source-a',day.date,day.activeUsers,day.sessions,day.pageViews,day.installEvents]));
    assert.deepEqual(channelInserts.flatMap(x=>x.params),channels.flatMap(row=>
      ['source-a',row.date,row.sourceMedium,row.sessions,row.activeUsers]));
    assert.equal(dailyInserts.length,Math.ceil(daily.length/16));
    assert.equal(channelInserts.length,Math.ceil(channels.length/20));
  });
}
test('GA4 schedule is DST-safe and independent from existing CWS hours',()=>{
  assert.deepEqual(dueGa4Range(Date.UTC(2026,10,7,17)),
    {dateFrom:'2026-10-31',dateTo:'2026-11-06'});
  assert.deepEqual(dueGa4Range(Date.UTC(2026,6,7,16)),
    {dateFrom:'2026-06-30',dateTo:'2026-07-06'});
  assert.equal(dueGa4Range(Date.UTC(2026,10,7,16)),null);
});
