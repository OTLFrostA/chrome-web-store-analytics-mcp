import { refreshGoogleAccessToken } from '../google.js';
import { googleFetch } from '../rate-limit.js';

const BASE = 'https://chromewebstore.googleapis.com/v2/publishers/';
const PAGE_SIZE = 200;
const DEFAULT_PAGES = 5;
const MAX_PAGES = 10;
const MAX_COMMENT = 20000;

export async function getReviewSettings(db, googleSub, itemId) {
  const row = await db.prepare('SELECT enabled,max_pages AS maxPages FROM review_collection_settings ' +
    'WHERE google_sub=? AND item_id=?').bind(googleSub,itemId).first();
  return {enabled:row ? row.enabled===1 || row.enabled===true : true,
    maxPages:row ? row.maxPages : DEFAULT_PAGES};
}

export async function setReviewSettings(db, googleSub, itemId, {enabled,maxPages}) {
  const previous = await getReviewSettings(db,googleSub,itemId);
  const next = {enabled:enabled===undefined ? previous.enabled : enabled,
    maxPages:maxPages===undefined ? previous.maxPages : maxPages};
  if (typeof next.enabled!=='boolean'||!Number.isInteger(next.maxPages)||
      next.maxPages<1||next.maxPages>MAX_PAGES) {
    throw new Error('Review settings require an enabled flag and a 1-10 page limit.');
  }
  await db.prepare('INSERT INTO review_collection_settings (google_sub,item_id,enabled,max_pages) ' +
    'VALUES (?,?,?,?) ON CONFLICT(google_sub,item_id) DO UPDATE SET ' +
    'enabled=excluded.enabled,max_pages=excluded.max_pages,updated_at=CURRENT_TIMESTAMP')
    .bind(googleSub,itemId,next.enabled?1:0,next.maxPages).run();
  return next;
}

export function normalizeReview(review, publisherId, itemId) {
  if (!review||typeof review!=='object'||Array.isArray(review)||
      typeof review.name!=='string'||!/^reviews\/[^/\s?&#]{1,256}$/.test(review.name)||
      !Number.isInteger(review.rating)||review.rating<1||review.rating>5||
      typeof review.createTime!=='string'||!Number.isFinite(Date.parse(review.createTime))||
      (review.item!==undefined&&review.item!=='publishers/'+publisherId+'/items/'+itemId)||
      (review.comment!==undefined&&typeof review.comment!=='string')||
      (review.authorInfo!==undefined&&(!review.authorInfo||
        typeof review.authorInfo!=='object'||Array.isArray(review.authorInfo)))||
      (review.authorInfo?.displayName!==undefined&&
        typeof review.authorInfo.displayName!=='string')) {
    throw new Error('Invalid Chrome Web Store review response.');
  }
  const comment=review.comment??'';
  const authorName=review.authorInfo?.displayName??'';
  if(comment.length>MAX_COMMENT||authorName.length>1024) {
    throw new Error('Chrome Web Store review exceeds the supported size.');
  }
  return {reviewName:review.name,rating:review.rating,comment,
    authorName,createTime:new Date(review.createTime).toISOString()};
}

// The Google REST docs use createTime, while generated clients and API discovery
// historically advertise create_time. Keep a bounded fallback for API variance.
export async function fetchReviewPage(accessToken, publisherId, itemId,
  pageToken, request=fetch, orderBy='create_time desc') {
  if(orderBy!=='create_time desc' && orderBy!=='createTime desc')
    throw new Error('Invalid review order.');

  const url=new URL(BASE+encodeURIComponent(publisherId)+'/items/'+
    encodeURIComponent(itemId)+':fetchReviews');
  url.searchParams.set('pageSize',String(PAGE_SIZE));
  url.searchParams.set('orderBy',orderBy);
  if(pageToken)url.searchParams.set('pageToken',pageToken);
  const response=await request(url.toString(),{
    method:'GET',redirect:'manual',
    headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'},
  });
  if(!response.ok) {
    let code = '';
    if(response.status===400) {
      // Never return or log the provider response, which may identify users.
      let body = '';
      try { body=(await response.text()).slice(0,4096).toLowerCase(); } catch {}
      if(/order.?by|create.?time|sort/.test(body))code='_invalid_order';
      else if(/page.?size|page.?token/.test(body))code='_invalid_pagination';
      else if(/publisher|item|resource.?name/.test(body))code='_invalid_resource';
    }
    throw new Error('Chrome Web Store reviews request failed (HTTP '+
      response.status+code+').');
  }
  let payload;
  try{payload=await response.json();}catch{throw new Error('Invalid Chrome Web Store reviews JSON.');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
      (payload.reviews!==undefined&&!Array.isArray(payload.reviews))||
      (payload.nextPageToken!==undefined&&typeof payload.nextPageToken!=='string')) {
    throw new Error('Invalid Chrome Web Store reviews response.');
  }
  return {reviews:(payload.reviews??[]).map(x=>normalizeReview(x,publisherId,itemId)),
    nextPageToken:payload.nextPageToken||null};
}

export async function saveReviewPage(db,googleSub,itemId,reviews) {
  if(reviews.length===0)return {newReviews:0,updatedReviews:0};
  const ids=[...new Set(reviews.map(x=>x.reviewName))];
  const placeholders=ids.map(()=>'?').join(',');
  const {results}=await db.prepare('SELECT review_name AS name FROM review_history '+
    'WHERE google_sub=? AND item_id=? AND review_name IN ('+placeholders+')')
    .bind(googleSub,itemId,...ids).all();
  const known=new Set((results??[]).map(x=>x.name));
  const unique=new Map(reviews.map(x=>[x.reviewName,x]));
  const records=[...unique.values()];
  const statement='INSERT INTO review_history '+
    '(google_sub,item_id,review_name,rating,comment,author_name,create_time) '+
    'VALUES (?,?,?,?,?,?,?) ON CONFLICT(google_sub,item_id,review_name) DO UPDATE SET '+
    'rating=excluded.rating,comment=excluded.comment, '+
    'author_name=excluded.author_name,create_time=excluded.create_time, '+
    'last_seen_at=CURRENT_TIMESTAMP';
  // Bound each D1 transaction; no raw comments or reviewer names in logs.
  for(let i=0;i<records.length;i+=50) {
    await db.batch(records.slice(i,i+50).map(row=>db.prepare(statement).bind(
      googleSub,itemId,row.reviewName,row.rating,row.comment,row.authorName,row.createTime,
    )));
  }
  const newReviews=records.filter(x=>!known.has(x.reviewName)).length;
  return {newReviews,updatedReviews:records.length-newReviews};
}

export async function getSavedReviews(db,googleSub,itemId,{limit=100,newWithinDays=0}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>200||
      !Number.isInteger(newWithinDays)||newWithinDays<0||newWithinDays>365) {
    throw new Error('Invalid review history pagination.');
  }
  const filter=newWithinDays>0 ? " AND first_seen_at >= datetime('now', ?)" : '';
  const params=[googleSub,itemId];
  if(newWithinDays>0)params.push('-'+newWithinDays+' days');
  const {results}=await db.prepare('SELECT review_name AS reviewName,rating,comment, '+
    'author_name AS authorName,create_time AS createTime, '+
    'first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt '+
    'FROM review_history WHERE google_sub=? AND item_id=?'+filter+
    ' ORDER BY create_time DESC,review_name DESC LIMIT ?')
    .bind(...params,limit).all();
  return results??[];
}

export async function collectReviews({env,googleSub,item,refreshToken,
  request=fetch,paceMs=3200}) {
  if(!refreshToken)throw new Error('Google OAuth credential is required to collect reviews.');
  const settings=await getReviewSettings(env.MCP_DB,googleSub,item.itemId);
  if(!settings.enabled)return {rowsWritten:0,skipped:true,reason:'Review collection is disabled.'};
  const checked=googleFetch(env.GOOGLE_API_RATE_LIMITER,googleSub,request);
  let nextRequestAt=0;
  const paced=async(url,options)=>{
    const pause=Math.max(0,nextRequestAt-Date.now());
    if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
    nextRequestAt=Date.now()+paceMs;
    return checked(url,options);
  };
  const accessToken=await refreshGoogleAccessToken(env,refreshToken,paced);
  let token=null,newReviews=0,updatedReviews=0,pagesFetched=0,fetched=0;
  let orderBy='create_time desc';
  const seenTokens=new Set();
  let hasMore=false;
  for(let page=0;page<settings.maxPages;page++) {
    let data;
    try {
      data=await fetchReviewPage(accessToken,item.publisherId,item.itemId,token,paced,orderBy);
    } catch(error) {
      // Retry the *first* page only if Google rejects the field syntax (HTTP 400).
      // Keep the selected spelling fixed across subsequent page tokens.
      if(page!==0 || !(error instanceof Error) || !/HTTP 400/.test(error.message))
        throw error;
      orderBy='createTime desc';
      data=await fetchReviewPage(accessToken,item.publisherId,item.itemId,token,paced,orderBy);
    }
    pagesFetched++;
    fetched+=data.reviews.length;
    const saved=await saveReviewPage(env.MCP_DB,googleSub,item.itemId,data.reviews);
    newReviews+=saved.newReviews;
    updatedReviews+=saved.updatedReviews;
    token=data.nextPageToken;
    hasMore=!!token;
    if(!token)break;
    if(seenTokens.has(token))throw new Error('Chrome Web Store review pagination repeated a token.');
    seenTokens.add(token);
  }
  return {rowsWritten:newReviews,newReviews,updatedReviews,fetched,pagesFetched,
    truncated:hasMore};
}
