import { addDate } from "./dates.js";
import { METRICS } from "./metrics.js";
import { dateRange, MAX_OUTPUT_ROWS } from "./validation.js";

export const DIMENSIONS = [
  "overall", "os", "app-version", "country", "install-source", "install-type",
  "language", "enabled", "utm-campaign", "utm-content", "utm-medium",
  "utm-source", "utm-term",
];

export function assertMetricSelection(metric, dimension = "overall") {
  if (!METRICS.includes(metric)) throw new Error("Unsupported metric: " + String(metric));
  if (!DIMENSIONS.includes(dimension)) throw new Error("Unsupported dimension: " + String(dimension));
}

// The one Google API metrics parser used by both cron and live queries.
// No client output cap is applied here: every fetched page must be persisted
// before a higher layer returns a bounded response.
export async function fetchMetricBatch(token, publisherId, itemId, job, days, request = fetch) {
  const dimension = job.dimension || "overall";
  for (const metric of job.metrics) assertMetricSelection(metric, dimension);
  const {from,to} = dateRange(days), rows = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://chromewebstore.googleapis.com/v2/publishers/" +
      encodeURIComponent(publisherId) + "/items/" + encodeURIComponent(itemId) + ":queryMetrics");
    for (const metric of job.metrics) url.searchParams.append("metrics", metric);
    if (dimension !== "overall") url.searchParams.set("dimensions", dimension);
    addDate(url, "timeSpec.firstDate", from);
    addDate(url, "timeSpec.lastDate", to);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await request(url.toString(), {
      method: "GET", redirect: "manual",
      headers: {Authorization: "Bearer " + token, Accept: "application/json"},
    });
    if (response.status === 401) {
      throw new Error("Google rejected your authorization (HTTP 401). Reconnect your Google account.");
    }
    if (response.status === 403 || response.status === 404) {
      throw new Error("Google could not access analytics for this extension (HTTP " + response.status +
        "). Check the Publisher ID and signed-in Google account.");
    }
    if (!response.ok) throw new Error("Chrome Web Store metrics request failed (HTTP " + response.status + ").");
    let data;
    try {data = await response.json();} catch {throw new Error("Google returned invalid metrics JSON.");}
    if (!data || !Array.isArray(data.metricRows ?? []) ||
        (data.nextPageToken !== undefined && typeof data.nextPageToken !== "string")) {
      throw new Error("Google returned an invalid metrics response.");
    }
    for (const row of data.metricRows ?? []) {
      if (!row.date || !Array.isArray(row.metricValues)) continue;
      const date = String(row.date.year) + "-" + String(row.date.month).padStart(2,"0") + "-" +
        String(row.date.day).padStart(2,"0");
      const rawDimension = dimension === "overall" ? "" : (row.dimensionValues?.[0] ?? "");
      const dimensionValue = typeof rawDimension === "string" ? rawDimension : JSON.stringify(rawDimension);
      for (const value of row.metricValues) {
        if (!job.metrics.includes(value.metric)) continue;
        const amount = Number(value.value);
        if (!Number.isFinite(amount)) throw new Error("Invalid Google metric value.");
        const uniqueUserCount = value.uniqueUserCount === undefined ? undefined : Number(value.uniqueUserCount);
        if (uniqueUserCount !== undefined && !Number.isFinite(uniqueUserCount)) {
          throw new Error("Invalid Google metric unique user count.");
        }
        rows.push({date,metric:value.metric,dimension,dimensionValue,value:amount,
          ...(uniqueUserCount===undefined?{}:{uniqueUserCount})});
      }
    }
    if (!data.nextPageToken) return rows;
    pageToken = data.nextPageToken;
  }
  throw new Error("Too many Google metrics pages. Try a shorter time period.");
}

// Retained for connection validation and test compatibility. External MCP
// queries go through queryAndStoreMetrics in query-service.js instead.
export async function queryMetrics(token, publisherId, itemId, metric, dimension, days, request = fetch) {
  const rows = await fetchMetricBatch(token,publisherId,itemId,
    {dimension:dimension==="overall"?null:dimension,metrics:[metric]},days,request);
  const {from,to} = dateRange(days);
  return {publisherId,itemId,metric,dimension,from,to,totalRows:rows.length,
    truncated:rows.length>MAX_OUTPUT_ROWS,
    rows:rows.slice(0,MAX_OUTPUT_ROWS).map(row=>({
      date:row.date,...(dimension==="overall"?{}:{dimensionValue:row.dimensionValue}),
      value:row.value,...(row.uniqueUserCount===undefined?{}:{uniqueUserCount:row.uniqueUserCount}),
    })),
    ...(rows.length>MAX_OUTPUT_ROWS?{note:"Too many rows to display. Reduce days or choose an overall dimension."}:{})};
}
