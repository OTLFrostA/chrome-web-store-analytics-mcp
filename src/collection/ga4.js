import { refreshGoogleAccessToken } from '../google.js';
import { executeSourceCollector } from './source-runner.js';

const ENDPOINT='https://analyticsdata.googleapis.com/v1beta/properties/';
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const CHUNK_LIMIT=10000;

export function validateGa4Range(dateFrom,dateTo) {
  if(typeof dateFrom!=='string'||typeof dateTo!=='string'||!DAY.test(dateFrom)||!DAY.test(dateTo))
    throw new TypeError('Use YYYY-MM-DD GA4 reporting dates.');
  const a=Date.parse(dateFrom+'T00:00:00Z'),b=Date.parse(dateTo+'T00:00:00Z');
  if(!Number.isFinite(a)||!Number.isFinite(b)||
    new Date(a).toISOString().slice(0,10)!==dateFrom||
    new Date(b).toISOString().slice(0,10)!==dateTo||b<a||(b-a)/86400000>=90)
    throw new TypeError('Select a valid GA4 date range of at most 90 days.');
}
function reportRequest(dateFrom,dateTo,dimensions,metrics,extra={}) {
  return {dateRanges:[{startDate:dateFrom,endDate:dateTo}],
    dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),
    limit:String(CHUNK_LIMIT),...extra};
}
async function queryReport({propertyId,accessToken,body,request=fetch}) {
  if(!/^\d{1,30}$/.test(propertyId))throw new TypeError('Invalid GA4 property ID.');
  const result=[];
  for(let offset=0;offset<=50000;offset+=CHUNK_LIMIT){
    const response=await request(ENDPOINT+propertyId+':runReport',{
      method:'POST',headers:{Authorization:'Bearer '+accessToken,
        'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({...body,offset:String(offset)}),
    });
    if(!response.ok){
      if(response.status===401||response.status===403)
        throw new Error('GA4 permission denied. Reconnect or grant access to this property.');
      if(response.status===400)throw new Error('GA4 report configuration was rejected.');
      throw new Error('GA4 service error (HTTP '+response.status+').');
    }
    const data=await response.json();
    const rows=Array.isArray(data.rows)?data.rows:
      (data.rowCount!==undefined&&Number(data.rowCount)===0?[]:null);
    if(!rows)throw new Error('GA4 report response has no valid rows array.');
    result.push(...rows);
    const rowCount=Number(data.rowCount??rows.length);
    if(!Number.isSafeInteger(rowCount)||rowCount<0||rowCount>50000)
      throw new Error('GA4 report is too large.');
    if(result.length>=rowCount)break;
    if(rows.length===0)throw new Error('GA4 report pagination was incomplete.');
  }
  return result;
}
function parseDate(raw){
  const date=raw?.dimensionValues?.[0]?.value;
  if(typeof date!=='string'||!/^\d{8}$/.test(date))throw new Error('Invalid GA4 report date.');
  return date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);
}
function numberAt(raw,index) {
  const value=raw?.metricValues?.[index]?.value;
  if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))
    throw new Error('Invalid GA4 numeric metric.');
  return Number(value);
}
export function parseGa4Reports({total,installs,channels,dateFrom,dateTo}) {
  validateGa4Range(dateFrom,dateTo);
  if(!total.length)throw new Error('GA4 reported no daily data for this date range.');
  const days=new Map();
  for(const row of total) {
    const date=parseDate(row);
    if(date<dateFrom||date>dateTo||days.has(date))throw new Error('Invalid GA4 daily data.');
    days.set(date,{date,activeUsers:numberAt(row,0),sessions:numberAt(row,1),
      pageViews:numberAt(row,2),installEvents:null});
  }
  for(const row of installs) {
    const date=parseDate(row),day=days.get(date);
    if(!day)throw new Error('Install event without daily GA4 coverage.');
    if(day.installEvents!==null)throw new Error('Duplicate GA4 install metric.');
    day.installEvents=numberAt(row,0);
  }
  const breakdown=new Map();
  for(const row of channels){
    const date=parseDate(row);
    const medium=row?.dimensionValues?.[1]?.value;
    if(!days.has(date)||typeof medium!=='string'||!medium||medium.length>250)
      throw new Error('Invalid GA4 source/medium.');
    const key=JSON.stringify([date,medium]);
    if(breakdown.has(key))throw new Error('Duplicate GA4 source/medium.');
    breakdown.set(key,{date,sourceMedium:medium,sessions:numberAt(row,0),activeUsers:numberAt(row,1)});
  }
  return {daily:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    channels:[...breakdown.values()].sort((a,b)=>a.date.localeCompare(b.date))};
}
export async function fetchGa4Reports({propertyId,accessToken,dateFrom,dateTo,request=fetch}) {
  validateGa4Range(dateFrom,dateTo);
  const range={propertyId,accessToken,request};
  const [total,installs,channels]=await Promise.all([
    queryReport({...range,body:reportRequest(dateFrom,dateTo,['date'],
      ['activeUsers','sessions','screenPageViews'])}),
    queryReport({...range,body:reportRequest(dateFrom,dateTo,['date'],['eventCount'],{
      dimensionFilter:{filter:{fieldName:'eventName',stringFilter:{value:'install'}}},
    })}),
    queryReport({...range,body:reportRequest(dateFrom,dateTo,['date','sessionSourceMedium'],
      ['sessions','activeUsers'])}),
  ]);
  return parseGa4Reports({total,installs,channels,dateFrom,dateTo});
}
export async function persistGa4Reports(db,{sourceId,dateFrom,dateTo,daily,channels}) {
  if(!daily.length)throw new Error('Empty GA4 data must not overwrite history.');
  const coveredDates=daily.map(day=>day.date);
  const datesList=coveredDates.map(()=>'?').join(',');
  const statements=[
    db.prepare('DELETE FROM ga4_daily_history WHERE source_id=? AND date IN ('+datesList+')')
      .bind(sourceId,...coveredDates),
    db.prepare('DELETE FROM ga4_channel_history WHERE source_id=? AND date IN ('+datesList+')')
      .bind(sourceId,...coveredDates),
  ];
  const bulkInsert=(table,columns,values)=>{
    for(let i=0;i<values.length;i+=100){
      const rows=values.slice(i,i+100);
      const params=rows.flat();
      const placeholders=rows.map(row=>'('+row.map(()=>'?').join(',')+')').join(',');
      statements.push(db.prepare('INSERT INTO '+table+' ('+columns.join(',')+
        ') VALUES '+placeholders).bind(...params));
    }
  };
  bulkInsert('ga4_daily_history',
    ['source_id','date','active_users','sessions','page_views','install_events'],
    daily.map(day=>[sourceId,day.date,day.activeUsers,day.sessions,day.pageViews,day.installEvents]));
  bulkInsert('ga4_channel_history',
    ['source_id','date','source_medium','sessions','active_users'],
    channels.map(row=>[sourceId,row.date,row.sourceMedium,row.sessions,row.activeUsers]));
  // D1 batch is transactional; a failed write cannot leave partially replaced data.
  await db.batch(statements);
  return daily.length+channels.length;
}
export const GA4_COLLECTOR=Object.freeze({
  id:'ga4-analytics',sourceTypes:['ga4'],
  async collect({env,source,auth,dateFrom,dateTo,request=fetch}) {
    if(auth.kind!=='oauth'||!auth.token)throw new Error('GA4 OAuth credential required.');
    const accessToken=await refreshGoogleAccessToken(env,auth.token,request);
    const {daily,channels}=await fetchGa4Reports({
      propertyId:source.externalResourceId,accessToken,dateFrom,dateTo,request});
    const rowsWritten=await persistGa4Reports(env.MCP_DB,{
      sourceId:source.sourceId,dateFrom,dateTo,daily,channels});
    return {sourceId:source.sourceId,propertyId:source.externalResourceId,
      dateFrom,dateTo,rowsWritten,daily,channels};
  },
});
export async function collectGa4Source({env,ownerUserId,sourceId,dateFrom,dateTo,request=fetch}) {
  validateGa4Range(dateFrom,dateTo);
  return executeSourceCollector({env,ownerUserId,sourceId,
    collector:{...GA4_COLLECTOR,collect:args=>
      GA4_COLLECTOR.collect({...args,dateFrom,dateTo,request})}});
}
export async function readGa4History(db,{ownerUserId,sourceId,dateFrom,dateTo}) {
  validateGa4Range(dateFrom,dateTo);
  // Enforce source ownership in each read, including the channel breakdown.
  const {getDataSource}=await import('../data-sources.js');
  const source=await getDataSource(db,ownerUserId,sourceId);
  if(source.sourceType!=='ga4')throw new Error('This data source is not GA4.');
  const [d,c]=await Promise.all([
    db.prepare(`SELECT date,active_users AS activeUsers,sessions,page_views AS pageViews,
      install_events AS installEvents,collected_at AS collectedAt FROM ga4_daily_history
      WHERE source_id=? AND date BETWEEN ? AND ? ORDER BY date`)
      .bind(sourceId,dateFrom,dateTo).all(),
    db.prepare(`SELECT date,source_medium AS sourceMedium,sessions,active_users AS activeUsers,
      collected_at AS collectedAt FROM ga4_channel_history WHERE source_id=?
      AND date BETWEEN ? AND ? ORDER BY date,source_medium`)
      .bind(sourceId,dateFrom,dateTo).all(),
  ]);
  return {sourceId,propertyId:source.externalResourceId,
    daily:d.results??[],channels:c.results??[]};
}
