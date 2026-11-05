import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchExtensionStatus, getRatingSummary } from "../src/read-only.js";
import { fetchReviewPage } from "../src/collection/reviews.js";
import { queryMetrics } from "../src/query.js";

const publisherId = "example-publisher";
const itemId = "abcdefghijklmnopabcdefghijklmnop";
const name = "publishers/" + publisherId + "/items/" + itemId;

test("fetchStatus reads the official GET endpoint and preserves publishing state", async () => {
  let sent;
  const status = {
    name, itemId, publicKey: "public-extension-key",
    publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [
      { crxVersion: "1.2.3", deployPercentage: 30 },
    ] },
    submittedItemRevisionStatus: { state: "PENDING_REVIEW" },
    lastAsyncUploadState: "UPLOAD_SUCCEEDED", warned: true, takenDown: false,
  };
  const response = await fetchExtensionStatus("private-token", publisherId, itemId,
    async (url, options) => {
      sent = { url, options };
      return Response.json(status);
    });
  assert.equal(sent.url,
    "https://chromewebstore.googleapis.com/v2/" + name + ":fetchStatus");
  assert.equal(sent.options.method, "GET");
  assert.equal(sent.options.redirect, "manual");
  assert.equal(sent.options.headers.Authorization, "Bearer private-token");
  assert.equal(response.publishedItemRevisionStatus.distributionChannels[0].deployPercentage, 30);
  assert.equal(response.submittedItemRevisionStatus.state, "PENDING_REVIEW");
  assert.equal(response.warned, true);
  assert.equal(response.publisherId, publisherId);
});

test("rating summary uses the official singleton resource and keeps int64 counts", async () => {
  let called;
  const response = await getRatingSummary("token", publisherId, itemId, async url => {
    called = url;
    return Response.json({ name: name + "/ratingSummary", rating: 4.8,
      ratingCount: "9007199254740993", nonEmptyReviewCount: "20",
      oneStarRatingCount: "1", fiveStarRatingCount: "18" });
  });
  assert.equal(called, "https://chromewebstore.googleapis.com/v2/" + name + "/ratingSummary");
  assert.equal(response.rating, 4.8);
  assert.equal(response.ratingCount, "9007199254740993");
  assert.equal(response.fiveStarRatingCount, "18");
});

test("read-only endpoint rejects a mismatched linked extension or invalid JSON", async () => {
  await assert.rejects(fetchExtensionStatus("token", publisherId, itemId,
    async () => Response.json({ name: "publishers/wrong/items/" + itemId })),
    /does not match/);
  await assert.rejects(fetchExtensionStatus("token", publisherId, itemId,
    async () => Response.json({ itemId, warned: false })),
    /does not match/);
  await assert.rejects(getRatingSummary("token", publisherId, itemId,
    async () => Response.json({ itemId: "another-item" })),
    /does not match/);
  await assert.rejects(fetchExtensionStatus("token", publisherId, itemId,
    async () => new Response("<html>", { status: 200 })),
    /invalid Chrome Web Store JSON/);
});

test("provider errors do not echo private response bodies or access tokens", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(fetchExtensionStatus("secret-token", publisherId, itemId,
      async () => new Response("user@example.com secret-token", { status })),
      error => {
        assert.match(error.message, new RegExp("HTTP " + status));
        assert.doesNotMatch(error.message, /secret-token|user@example.com/);
        return true;
      });
  }
  await assert.rejects(getRatingSummary("secret-token", publisherId, itemId,
    async () => Response.redirect("https://untrusted.example", 302)), /HTTP 302/);
});

test("live reviews use official filters, sorted pages and account OAuth token", async () => {
  let seen;
  const sample = {
    name: "reviews/123", item: name, rating: 2, comment: "Needs improvement",
    authorInfo: { displayName: "Tester" }, createTime: "2026-11-02T10:00:00Z",
  };
  const response = await fetchReviewPage("private-token", publisherId, itemId, "continue",
    async (url, options) => {
      seen = { url: new URL(url), options };
      return Response.json({ reviews: [sample], nextPageToken: "next" });
    }, "rating asc, createTime desc", { pageSize: 25, rating: 2 });
  assert.equal(seen.url.pathname, "/v2/" + name + ":fetchReviews");
  assert.equal(seen.url.searchParams.get("pageSize"), "25");
  assert.equal(seen.url.searchParams.get("filter"), "rating = 2");
  assert.equal(seen.url.searchParams.get("orderBy"), "rating asc, createTime desc");
  assert.equal(seen.url.searchParams.get("pageToken"), "continue");
  assert.equal(seen.options.headers.Authorization, "Bearer private-token");
  assert.equal(response.nextPageToken, "next");
  assert.equal(response.reviews[0].rating, 2);
});

test("live review filters and page tokens are bounded before any network call", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ reviews: [] }); };
  for (const options of [{pageSize:0}, {pageSize:201}, {rating:0}, {rating:6}]) {
    await assert.rejects(fetchReviewPage("token", publisherId, itemId,
      null, request, "createTime desc", options));
  }
  await assert.rejects(fetchReviewPage("token", publisherId, itemId,
    "x".repeat(4097), request, "createTime desc", { pageSize: 50 }));
  await assert.rejects(fetchReviewPage("token", publisherId, itemId,
    null, request, "unspecified; malicious order"));
  assert.equal(calls, 0);
});

test("analytics passes newly supported dimensions to Google and sanitizes errors", async () => {
  let seen;
  await queryMetrics("token", publisherId, itemId, "impressions", "utm-campaign", 2,
    async url => { seen = new URL(url); return Response.json({ metricRows: [] }); });
  assert.equal(seen.searchParams.get("dimensions"), "utm-campaign");
  await assert.rejects(queryMetrics("token", publisherId, itemId,
    "page-views", "country", 2,
    async () => new Response("secret client data", { status: 400 })),
    error => {
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /secret client data/);
      return true;
    });
});

test("all four official v2 GET endpoints are registered as read-only MCP tools", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  for (const name of ["query_metrics", "fetch_reviews", "get_extension_status",
    "get_rating_summary"]) {
    const start = source.indexOf('server.registerTool("' + name + '"');
    assert.ok(start >= 0, "missing MCP tool " + name);
    const configurationEnd = source.indexOf("}, async", start);
    assert.ok(configurationEnd > start, "missing tool handler " + name);
    assert.match(source.slice(start, configurationEnd), /readOnlyHint: true/);
  }
});
