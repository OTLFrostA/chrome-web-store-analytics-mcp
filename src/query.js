import { addDate } from "./dates.js";
import { JOBS } from "./jobs.js";
import { METRICS } from "./metrics.js";
import { dateRange, MAX_OUTPUT_ROWS } from "./validation.js";

export const DIMENSIONS = ["overall", "install-source", "install-type", "os", "utm-source", "country", "app-version"];

export function assertMetricSelection(metric, dimension = "overall") {
  if (!METRICS.includes(metric)) throw new Error("Unsupported metric: " + String(metric));
  if (!DIMENSIONS.includes(dimension)) throw new Error("Unsupported dimension: " + String(dimension));
  if (!JOBS.some(job => (job.dimension || "overall") === dimension && job.metrics.includes(metric))) {
    throw new Error("This metric and dimension combination is not supported by Chrome Web Store.");
  }
}

export async function queryMetrics(token, publisherId, itemId, metric, dimension, days, request = fetch) {
  assertMetricSelection(metric, dimension);
  const { from, to } = dateRange(days);
  const rows = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://chromewebstore.googleapis.com/v2/publishers/" +
      encodeURIComponent(publisherId) + "/items/" + encodeURIComponent(itemId) + ":queryMetrics");
    url.searchParams.append("metrics", metric);
    if (dimension !== "overall") url.searchParams.set("dimensions", dimension);
    addDate(url, "timeSpec.firstDate", from);
    addDate(url, "timeSpec.lastDate", to);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await request(url.toString(), {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (response.status === 401) {
      throw new Error("Google rejected your authorization (HTTP 401). Reconnect the Google account that owns your Chrome Web Store extensions.");
    }
    if (response.status === 403 || response.status === 404) {
      throw new Error("Google could not access analytics for this extension (HTTP " + response.status +
        "). Check the Publisher ID and signed-in Google account. Open https://chrome.google.com/webstore/developer/dashboard, select the correct publisher, then go to Publisher > Settings. Paste the Publisher ID or that page URL and try again.");
    }
    if (!response.ok) throw new Error("Chrome Web Store metrics request failed (HTTP " + response.status + ").");
    const data = await response.json();
    if (!Array.isArray(data.metricRows || [])) throw new Error("Google returned an invalid metrics response.");
    rows.push(...(data.metricRows || []));
    if (!data.nextPageToken) {
      const compact = rows.map(row => {
        const m = (row.metricValues || []).find(value => value.metric === metric);
        if (!m || !row.date) return null;
        const year = String(row.date.year);
        const month = String(row.date.month).padStart(2, "0");
        const day = String(row.date.day).padStart(2, "0");
        return {
          date: year + "-" + month + "-" + day,
          ...(dimension === "overall" ? {} : { dimensionValue: row.dimensionValues?.[0] ?? null }),
          value: Number(m.value ?? 0),
          ...(m.uniqueUserCount === undefined ? {} : { uniqueUserCount: Number(m.uniqueUserCount) }),
        };
      }).filter(Boolean);
      return {
        publisherId, itemId, metric, dimension, from, to,
        totalRows: compact.length,
        truncated: compact.length > MAX_OUTPUT_ROWS,
        rows: compact.slice(0, MAX_OUTPUT_ROWS),
        ...(compact.length > MAX_OUTPUT_ROWS ? {
          note: "Too many rows to display. Reduce days or choose the overall dimension.",
        } : {}),
      };
    }
    pageToken = data.nextPageToken;
  }
  throw new Error("Too many result pages. Try fewer days.");
}
