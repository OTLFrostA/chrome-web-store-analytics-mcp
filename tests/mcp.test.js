import test from "node:test";
import assert from "node:assert/strict";
import { parseStoreUrl, parsePublisherId, dateRange } from "../src/validation.js";
import { assertMetricSelection, queryMetrics } from "../src/query.js";
import { googleAuthorizeUrl, makeCodeVerifier, googleOAuthUserId } from "../src/google.js";
import { Script } from "node:vm";
import { SETUP_HTML, SETUP_MIME_TYPE, SETUP_RESOURCE_URI } from "../src/setup-ui.js";
import { publicPage } from "../src/public-pages.js";

const item = "abcdefghijklmnopabcdefghijklmnop";
const publisher = "sample-publisher-1234";

test("store URL parses the item ID without trusting a lookalike host", () => {
  assert.deepEqual(parseStoreUrl("https://chromewebstore.google.com/detail/sample-extension/" + item + "?utm_source=foo"), {
    itemId: item,
    storeUrl: "https://chromewebstore.google.com/detail/" + item,
  });
  for (const address of [
    "https://chromewebstore.google.com.evil.com/detail/foo/" + item,
    "http://chromewebstore.google.com/detail/foo/" + item,
    "https://evil.com/detail/foo/" + item,
    "https://chromewebstore.google.com/search?q=test",
  ]) assert.throws(() => parseStoreUrl(address));
});

test("publisher ID or publisher-specific Dashboard URL resolves to the same ID", () => {
  assert.equal(parsePublisherId(" " + publisher + " "), publisher);
  for (const suffix of ["/settings", "/items", ""]) {
    assert.equal(parsePublisherId("https://chrome.google.com/webstore/devconsole/" + publisher + suffix), publisher);
  }
  assert.equal(parsePublisherId("https://chrome.google.com/webstore/devconsole/" + publisher +
    "/settings?authuser=0&hl=en"), publisher);
});

test("generic dashboard URLs and untrusted origins cannot become publisher IDs", () => {
  for (const invalid of ["", "../foo", "/foo", "bad id", "x".repeat(129),
    "https://chrome.google.com/webstore/developer/dashboard",
    "https://chrome.google.com/webstore/devconsole/",
    "https://chrome.google.com/webstore/devconsole/settings",
    "https://chrome.google.com/webstore/devconsole/items",
    "http://chrome.google.com/webstore/devconsole/" + publisher + "/settings",
    "https://chrome.google.com.evil.com/webstore/devconsole/" + publisher + "/settings",
    "https://example.com/webstore/devconsole/" + publisher + "/settings",
    "https://chrome.google.com@evil.com/webstore/devconsole/" + publisher + "/settings",
    "https://chrome.google.com/webstore/devconsole/../settings",
    "https://chrome.google.com/webstore/devconsole/" + publisher + "/settings".repeat(600),
  ]) assert.throws(() => parsePublisherId(invalid), invalid);
  assert.throws(() => parsePublisherId("https://chrome.google.com/webstore/developer/dashboard"), /homepage/);
});

test("UTC range excludes current day, has length exactly days, and caps it", () => {
  assert.deepEqual(dateRange(7, new Date("2026-11-01T23:20:00.000Z")), {
    from: "2026-10-25", to: "2026-10-31",
  });
  assert.throws(() => dateRange(91));
  assert.throws(() => dateRange(0));
});

test("query metrics accepts every documented dimension independently of scheduled jobs", () => {
  for (const dimension of ["overall", "os", "app-version", "country",
    "install-source", "install-type", "language", "enabled", "utm-campaign",
    "utm-content", "utm-medium", "utm-source", "utm-term"]) {
    assert.doesNotThrow(() => assertMetricSelection("installs", dimension));
  }
  // Google validates individual metric/dimension combinations on request.
  assert.doesNotThrow(() => assertMetricSelection("page-views", "country"));
  assert.throws(() => assertMetricSelection("not-a-metric", "overall"));
  assert.throws(() => assertMetricSelection("installs", "not-a-dimension"));
});

test("Google OAuth user IDs avoid the provider's reserved colon separator", () => {
  assert.equal(googleOAuthUserId("123456789"), "google-123456789");
  assert.ok(!googleOAuthUserId("123456789").includes(":"));
  assert.throws(() => googleOAuthUserId("a:b"), /Invalid Google account/);
});

test("Google OAuth asks for read-only stats plus identity with PKCE", async () => {
  const verifier = makeCodeVerifier();
  const url = new URL(await googleAuthorizeUrl(
    { GOOGLE_CLIENT_ID: "test-client" }, "https://example.com/callback", "state-123", verifier));
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.match(url.searchParams.get("scope"), /chromewebstore\.readonly/);
  assert.doesNotMatch(url.searchParams.get("scope"), /chromewebstore(?!\.readonly)/);
});

test("metrics request uses the connected IDs and account token", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: new URL(url), options };
    return new Response(JSON.stringify({ metricRows: [{
      date: { year: 2026, month: 10, day: 30 },
      metricValues: [{ metric: "installs", value: "3" }],
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await queryMetrics("per-user-token", publisher, item, "installs", "overall", 2);
    assert.equal(seen.url.pathname, "/v2/publishers/" + publisher + "/items/" + item + ":queryMetrics");
    assert.equal(seen.options.headers.Authorization, "Bearer per-user-token");
    assert.equal(response.rows[0].value, 3);
    assert.equal(response.dimension, "overall");
  } finally { globalThis.fetch = originalFetch; }
});

test("a 403 rejects a connection rather than treating it as empty metrics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("permission denied", { status: 403 });
  try {
    await assert.rejects(queryMetrics("other-user", publisher, item, "installs", "overall", 2),
      /Publisher ID/);
  } finally { globalThis.fetch = originalFetch; }
});

test("extension settings uses a standard MCP Apps resource and executable bridge script", () => {
  assert.match(SETUP_RESOURCE_URI, /^ui:\/\//);
  assert.equal(SETUP_MIME_TYPE, "text/html;profile=mcp-app");
  assert.match(SETUP_HTML, /ui\/initialize/);
  assert.match(SETUP_HTML, /ui\/notifications\/initialized/);
  assert.match(SETUP_HTML, /tools\/call/);
  const embedded = SETUP_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(embedded, "setup widget has an inline script");
  assert.doesNotThrow(() => new Script(embedded[1]));
});

test("settings UI calls existing account-bound tools and escapes user data", () => {
  for (const tool of ["get_profile", "list_extensions", "connect_extension", "remove_extension"]) {
    assert.ok(SETUP_HTML.includes('callTool("' + tool + '"'), "missing tool: " + tool);
  }
  assert.match(SETUP_HTML, /store-url/);
  assert.match(SETUP_HTML, /publisher-id/);
  assert.match(SETUP_HTML, /Publisher ID or Developer Dashboard URL/);
  assert.match(SETUP_HTML, /https:\/\/chrome\.google\.com\/webstore\/developer\/dashboard/);
  assert.match(SETUP_HTML, /Publisher → Settings/);
  assert.match(SETUP_HTML, /ui\/open-link/);
  assert.match(SETUP_HTML, /Confirm removal/);
  assert.match(SETUP_HTML, /textContent/);
  assert.doesNotMatch(SETUP_HTML, /\.innerHTML\s*=/);
  assert.doesNotMatch(SETUP_HTML, /GOOGLE_CLIENT_SECRET|refresh_token|window\.localStorage/);
});

test("public release pages are accessible, HTML, and do not expose credentials", async () => {
  for (const path of ["/", "/privacy", "/terms", "/support"]) {
    const response = publicPage(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /Chrome Web Store Analytics/);
    assert.doesNotMatch(html, /GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|CWS_GOOGLE_OAUTH_JSON/);
  }
  assert.equal(publicPage("/mcp"), null);
  assert.equal(publicPage("/oauth/token"), null);
});
