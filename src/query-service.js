import { fetchMetricBatch } from "./query.js";
import { dateRange, MAX_OUTPUT_ROWS } from "./validation.js";
import { saveMetricHistory, saveRankingHistory } from "./collection/history.js";
import { fetchExtensionStatus, getRatingSummary } from "./read-only.js";
import { saveRatingSnapshot, saveStatusEvent, saveWebStoreSearchSnapshot } from "./collection/snapshots.js";
import { fetchReviewPage, saveReviewPage, getReviewSettings } from "./collection/reviews.js";
import { searchWebStore } from "./collection/ranking.js";
import { submitBrightDataRankings, pollBrightDataRun } from "./collection/brightdata.js";
import { googleFetch } from "./rate-limit.js";
import { refreshGoogleAccessToken } from "./google.js";

// Only this layer is exposed to MCP handlers and scheduled collectors.
// Every provider read either persists its complete useful result or throws.
export async function googleQueryAccess({env, googleSub, refreshToken, request=fetch}) {
  const checked = googleFetch(env.GOOGLE_API_RATE_LIMITER, googleSub, request);
  const token = await refreshGoogleAccessToken(env, refreshToken, checked);
  return {token, request:checked};
}

export async function queryAndStoreMetricsBatch({
  db,googleSub,item,job,days,token,request=fetch,
}) {
  const rows = await fetchMetricBatch(token,item.publisherId,item.itemId,job,days,request);
  await saveMetricHistory(db,googleSub,item.itemId,rows);
  return rows;
}

export async function queryAndStoreMetrics({
  db,googleSub,item,metric,dimension="overall",days=14,token,request=fetch,
}) {
  const rows = await queryAndStoreMetricsBatch({
    db,googleSub,item,job:{dimension:dimension==="overall"?null:dimension,metrics:[metric]},
    days,token,request,
  });
  const {from,to} = dateRange(days);
  const truncated = rows.length>MAX_OUTPUT_ROWS;
  return {
    publisherId:item.publisherId,itemId:item.itemId,metric,dimension,from,to,
    totalRows:rows.length,truncated,
    rows:rows.slice(0,MAX_OUTPUT_ROWS).map(row=>({
      date:row.date,...(dimension==="overall"?{}:{dimensionValue:row.dimensionValue}),
      value:row.value,...(row.uniqueUserCount===undefined?{}:{uniqueUserCount:row.uniqueUserCount}),
    })),
    ...(truncated?{note:"All fetched rows were saved. Reduce days or narrow the dimension to display more rows."}:{}),
  };
}

export async function queryAndStoreStatus({db,googleSub,item,token,request=fetch}) {
  const status = await fetchExtensionStatus(token,item.publisherId,item.itemId,request);
  await saveStatusEvent(db,googleSub,item.itemId,status);
  return status;
}

export async function queryAndStoreRating({db,googleSub,item,token,request=fetch,now=Date.now()}) {
  const summary = await getRatingSummary(token,item.publisherId,item.itemId,request);
  await saveRatingSnapshot(db,googleSub,item.itemId,summary,now);
  return summary;
}

export async function queryAndStoreReviewPage({
  db,googleSub,item,token,pageToken=null,request=fetch,
  orderBy="create_time desc",pageSize=200,rating,
}) {
  const page=await fetchReviewPage(token,item.publisherId,item.itemId,pageToken,
    request,orderBy,{pageSize,rating});
  const persisted=await saveReviewPage(db,googleSub,item.itemId,page.reviews);
  return {...page,persisted};
}

export async function collectAndStoreReviews({env,googleSub,item,refreshToken,
  request=fetch,paceMs=3200}) {
  const settings=await getReviewSettings(env.MCP_DB,googleSub,item.itemId);
  if (!settings.enabled) return {rowsWritten:0,skipped:true,reason:"Review collection is disabled."};
  let nextRequestAt=0;
  const paced=async(url,options)=>{
    const pause=Math.max(0,nextRequestAt-Date.now());
    if (pause) await new Promise(resolve=>setTimeout(resolve,pause));
    nextRequestAt=Date.now()+paceMs;
    return request(url,options);
  };
  const access=await googleQueryAccess({env,googleSub,refreshToken,request:paced});
  let pageToken=null,orderBy="create_time desc",newReviews=0,updatedReviews=0,
    fetched=0,pagesFetched=0,truncated=false;
  const seen=new Set();
  for (let i=0;i<settings.maxPages;i++) {
    let page;
    try {
      page=await queryAndStoreReviewPage({
        db:env.MCP_DB,googleSub,item,token:access.token,pageToken,
        request:access.request,orderBy,
      });
    } catch (error) {
      if (i!==0 || !(error instanceof Error) || !/HTTP 400/.test(error.message)) throw error;
      orderBy="createTime desc";
      page=await queryAndStoreReviewPage({
        db:env.MCP_DB,googleSub,item,token:access.token,pageToken,
        request:access.request,orderBy,
      });
    }
    pagesFetched++;
    fetched+=page.reviews.length;
    newReviews+=page.persisted.newReviews;
    updatedReviews+=page.persisted.updatedReviews;
    pageToken=page.nextPageToken;
    truncated=!!pageToken;
    if (!pageToken) break;
    if (seen.has(pageToken)) throw new Error("Chrome Web Store reviews pagination repeated a token.");
    seen.add(pageToken);
  }
  return {rowsWritten:newReviews,newReviews,updatedReviews,pagesFetched,fetched,truncated};
}

export async function collectAndStoreMetadata({env,googleSub,item,refreshToken,request=fetch}) {
  const access=await googleQueryAccess({env,googleSub,refreshToken,request});
  await queryAndStoreStatus({
    db:env.MCP_DB,googleSub,item,token:access.token,request:access.request,
  });
  await queryAndStoreRating({
    db:env.MCP_DB,googleSub,item,token:access.token,request:access.request,
  });
  return {rowsWritten:2};
}

export async function queryAndStoreWebStoreRank({
  db,googleSub,item,keyword,locale="en-US",now=Date.now(),request=fetch,
}) {
  const results = await searchWebStore(keyword,locale,request);
  await saveWebStoreSearchSnapshot(db,googleSub,item.itemId,keyword,locale,results,now);
  const rank = await saveRankingHistory(db,googleSub,item.itemId,keyword,locale,results,now);
  return {...rank,results};
}

// Bright Data jobs are asynchronous: submission stores pending reservations and
// an account-bound snapshot ID; polling persists complete results before ACK.
export async function queryAndStoreBrightDataRankings(args) {
  return submitBrightDataRankings(args);
}
export async function refreshAndStoreBrightDataRankings(args) {
  return pollBrightDataRun(args);
}
