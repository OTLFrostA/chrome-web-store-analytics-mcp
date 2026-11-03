import test from "node:test";
import assert from "node:assert/strict";
import { protectRegistration } from "../src/registration.js";
import { googleFetch } from "../src/rate-limit.js";
import { refreshGoogleAccessToken } from "../src/google.js";
import { queryMetrics } from "../src/query.js";
import { disconnectGoogleAccount } from "../src/account-service.js";
import { maskCommands } from "../scripts/mask-production-config.mjs";

const metadata = { redirect_uris: ["https://client.example.com/callback"], client_name: "Sample client" };
function registration(body = JSON.stringify(metadata), headers = {}) {
  return new Request("https://example.com/oauth/register?test=1", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", ...headers }, body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

test("registration stops per-IP or aggregate abuse before any provider writes", async () => {
  for (const blocked of ["registration:ip:192.0.2.1", "registration:all"]) {
    let writes = 0;
    const response = await protectRegistration(registration(), {
      async limit({ key }) { return { success: key !== blocked }; },
    }, () => { writes++; });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(writes, 0);
  }
});

test("registration budgets block repeated anonymous clients and distinct IPs", async () => {
  const counts = new Map(); let writes = 0;
  const limiter = { async limit({ key }) {
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    return { success: count <= 20 };
  } };
  for (let i = 0; i < 25; i++) {
    const response = await protectRegistration(registration(undefined, { "CF-Connecting-IP": "192.0.2." + (i + 1) }), limiter,
      () => { writes++; return new Response(null, { status: 201 }); });
    assert.equal(response.status, i < 20 ? 201 : 429);
  }
  assert.equal(writes, 20);
});

test("registration fails closed on missing or failed rate limiting", async () => {
  for (const limiter of [undefined, { async limit() { throw new Error("unavailable"); } }]) {
    const response = await protectRegistration(registration(), limiter, () => assert.fail("must not write"));
    assert.equal(response.status, 503);
  }
});

test("registration bounds streamed bodies even without Content-Length", async () => {
  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(16385)); controller.close();
  } });
  const response = await protectRegistration(registration(oversized), { async limit() { return { success: true }; } },
    () => assert.fail("must not write"));
  assert.equal(response.status, 413);
});

test("registration bounds metadata and forwards valid clients without changing body", async () => {
  const limiter = { async limit() { return { success: true }; } };
  for (const body of ["bad json", "null", JSON.stringify({ ...metadata, redirect_uris: Array(6).fill(metadata.redirect_uris[0]) }),
    JSON.stringify({ ...metadata, client_name: "x".repeat(201) })]) {
    const response = await protectRegistration(registration(body), limiter, () => assert.fail("must not write"));
    assert.equal(response.status, 400);
  }
  const response = await protectRegistration(registration(), limiter, async request => {
    assert.deepEqual(await request.json(), metadata);
    return new Response(null, { status: 201 });
  });
  assert.equal(response.status, 201);
  const options = new Request("https://example.com/oauth/register", { method: "OPTIONS" });
  assert.equal((await protectRegistration(options, undefined, () => new Response(null, { status: 204 }))).status, 204);
});

test("D1 deletion failure still revokes every MCP session and hides backend errors", async () => {
  const revoked = [];
  await assert.rejects(disconnectGoogleAccount({
    googleSub: "alice", googleRefreshToken: "fixture",
    db: { prepare() { return { bind() { return { async run() { throw new Error("private database detail"); } }; } }; } },
    oauth: {
      async listUserGrants(userId) { return { items: [{ id: "one", userId }, { id: "two", userId }] }; },
      async revokeGrant(id) { revoked.push(id); if (id === "one") throw new Error("private KV detail"); },
    },
    async revokeGoogleToken() {},
  }), error => {
    assert.match(error.message, /saved extension data/);
    assert.match(error.message, /some MCP sessions/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(revoked, ["one", "two"]);
});

test("Google budget counts token refresh and every page, stopping before an excess fetch", async () => {
  let checks = 0, requests = 0;
  const request = googleFetch({ async limit() { return { success: ++checks <= 3 }; } }, "alice", async url => {
    requests++;
    return new Response(JSON.stringify(url === "https://oauth2.googleapis.com/token"
      ? { access_token: "fixture" }
      : { metricRows: [], nextPageToken: "next" }), { headers: { "Content-Type": "application/json" } });
  });
  const token = await refreshGoogleAccessToken({ GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture" }, "fixture", request);
  await assert.rejects(queryMetrics(token, "sample-publisher", "abcdefghijklmnopabcdefghijklmnop", "installs", "overall", 2, request), /Too many/);
  assert.equal(checks, 4);
  assert.equal(requests, 3); // One refresh, two pages, then no further request.
});

test("deployment masks IDs, names and separately printed endpoint components", () => {
  const commands = maskCommands(`name = "sample-worker"
account_id = "sample-account"
MCP_RESOURCE = "https://sample-worker.example.com/mcp"
id = 'sample-kv'
database_id = "sample-database"`, ["fixture-token"]);
  for (const value of ["sample-worker", "sample-account", "sample-kv", "sample-database", "fixture-token",
    "https://sample-worker.example.com/mcp", "https://sample-worker.example.com", "sample-worker.example.com"]) {
    assert.ok(commands.includes("::add-mask::" + value), value);
  }
  assert.deepEqual(maskCommands("", ["a%\nb\rc"]), ["::add-mask::a%25%0Ab%0Dc"]);
});
