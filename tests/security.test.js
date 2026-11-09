import test from "node:test";
import assert from "node:assert/strict";
import { listUserExtensions, saveUserExtension, removeUserExtension, selectUserExtension } from "../src/storage.js";
import { enforceGoogleRateLimit } from "../src/rate-limit.js";
import { disconnectGoogleAccount } from "../src/account-service.js";
import { revokeGoogleRefreshToken } from "../src/google.js";
import { oauthOptions, authorizedGoogleIdentity } from "../src/oauth-options.js";
import { resolveMcpOwner } from "../src/users.js";
import { SETUP_HTML } from "../src/setup-ui.js";

const aliceId = "abcdefghijklmnopabcdefghijklmnop";
const bobId = "ponmlkjihgfedcbaponmlkjihgfedcba";

function fakeDatabase() {
  const records = [
    { googleSub: "alice", itemId: aliceId, publisherId: "publisher-alice", storeUrl: "https://example.com/a" },
    { googleSub: "bob", itemId: bobId, publisherId: "publisher-bob", storeUrl: "https://example.com/b" },
  ];
  return {
    records,
    prepare(sql) {
      if (sql.startsWith("INSERT")) assert.match(sql, /INSERT INTO user_extensions/);
      else assert.match(sql, /google_sub = \?/);
      return {
        bind(...args) {
          return {
            async all() {
              return { results: records.filter(row => row.googleSub === args[0]).map(row =>
                ({ itemId: row.itemId, publisherId: row.publisherId, storeUrl: row.storeUrl })) };
            },
            async run() {
              if (sql.startsWith("INSERT")) {
                const [googleSub, itemId, publisherId, storeUrl] = args;
                const old = records.find(row => row.googleSub === googleSub && row.itemId === itemId);
                if (old) Object.assign(old, { publisherId, storeUrl });
                else records.push({ googleSub, itemId, publisherId, storeUrl });
                return { meta: { changes: 1 } };
              }
              let removed = 0;
              for (let i = records.length - 1; i >= 0; i--) {
                if (records[i].googleSub === args[0] && (args.length === 1 || records[i].itemId === args[1])) {
                  records.splice(i, 1);
                  removed++;
                }
              }
              return { meta: { changes: removed } };
            },
          };
        },
      };
    },
  };
}

test("account-bound D1 cannot select, remove or overwrite another user's extensions", async () => {
  const db = fakeDatabase();
  const aliceLinks = await listUserExtensions(db, "alice");
  assert.equal(aliceLinks.length, 1);
  assert.equal(selectUserExtension(aliceLinks, aliceId).itemId, aliceId);
  assert.throws(() => selectUserExtension(aliceLinks, bobId), /Choose one/);
  assert.equal(await removeUserExtension(db, "alice", bobId), false);
  await saveUserExtension(db, "alice", { itemId: aliceId, publisherId: "updated", storeUrl: "https://example.com/new" });
  assert.equal((await listUserExtensions(db, "bob"))[0].publisherId, "publisher-bob");
  assert.equal(db.records.length, 2);
});

test("MCP user ID is verified against authenticated Google OAuth props", () => {
  assert.equal(authorizedGoogleIdentity({ props: { googleSub: "alice" }, auth: { userId: "google-alice" } }), true);
  assert.equal(authorizedGoogleIdentity({ props: { googleSub: "bob" }, auth: { userId: "google-alice" } }), false);
  assert.equal(authorizedGoogleIdentity({ props: { googleSub: "alice" }, auth: {} }), false);
});

test("MCP data source owner uses verified Google props and isolates application users", async () => {
  const identities = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /FROM app_user_identities/);
              const userId = identities.get(args[0] + ":" + args[1]);
              return userId ? { userId } : null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO app_users")) return { meta: { changes: 1 } };
              if (sql.startsWith("INSERT INTO app_user_identities")) {
                const [provider, subject, userId] = args;
                const key = provider + ":" + subject;
                if (!identities.has(key)) identities.set(key, userId);
                return { meta: { changes: 1 } };
              }
              throw new Error("Unexpected SQL: " + sql);
            },
          };
        },
      };
    },
  };

  // The OAuthProvider request boundary rejects mismatched and missing identities.
  const aliceSession = { props: { googleSub: "alice" }, auth: { userId: "google-alice" } };
  assert.equal(authorizedGoogleIdentity(aliceSession), true);
  assert.equal(authorizedGoogleIdentity({ props: aliceSession.props, auth: { userId: "google-bob" } }), false);
  assert.equal(authorizedGoogleIdentity({ props: aliceSession.props }), false);

  // Tool callbacks receive authenticated props but not the outer ctx.auth.
  const alice = await resolveMcpOwner(db, aliceSession.props.googleSub);
  assert.equal(await resolveMcpOwner(db, "alice"), alice);
  const bob = await resolveMcpOwner(db, "bob");
  assert.notEqual(alice, bob);
  assert.deepEqual([...identities.keys()].sort(), ["mcp:google-alice", "mcp:google-bob"]);
  await assert.rejects(resolveMcpOwner(db, "invalid:subject"), /Invalid Google account identifier/);
  await assert.rejects(resolveMcpOwner(db, undefined), /Invalid Google account identifier/);
});

test("Google API rate limiting uses verified subject and fails closed", async () => {
  const keys = [];
  await enforceGoogleRateLimit({ async limit({ key }) { keys.push(key); return { success: true }; } }, "alice");
  assert.deepEqual(keys, ["google:alice"]);
  await assert.rejects(enforceGoogleRateLimit({ async limit() { return { success: false }; } }, "alice"), /Too many/);
  await assert.rejects(enforceGoogleRateLimit(undefined, "alice"), /not configured/);
});

test("Google revocation sends refresh tokens in POST bodies, not URLs", async () => {
  let seen;
  await revokeGoogleRefreshToken("private-refresh-token", async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200 };
  });
  assert.equal(seen.url, "https://oauth2.googleapis.com/revoke");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.body.get("token"), "private-refresh-token");
  await assert.rejects(revokeGoogleRefreshToken("token", async () => ({ ok: false, status: 503 })), /Try again/);
  await assert.doesNotReject(revokeGoogleRefreshToken("token", async () => ({ ok: false, status: 400 })));
});

test("disconnect revokes Google and only that account's MCP grants and D1 records", async () => {
  const db = fakeDatabase(), actions = [];
  const oauth = {
    async listUserGrants(userId) { actions.push("list"); assert.equal(userId, "google-alice"); return { items: [{ id: "alice-grant", userId }] }; },
    async revokeGrant(id, userId) { actions.push("grant"); assert.equal(id, "alice-grant"); assert.equal(userId, "google-alice"); },
  };
  const result = await disconnectGoogleAccount({
    googleSub: "alice", googleRefreshToken: "refresh", db, oauth,
    async revokeGoogleToken(token) { actions.push("google"); assert.equal(token, "refresh"); },
  });
  assert.deepEqual(actions, ["list", "google", "grant"]);
  assert.equal(result.disconnected, true);
  assert.equal(result.removedExtensions, 1);
  assert.equal((await listUserExtensions(db, "bob")).length, 1);
  assert.equal((await listUserExtensions(db, "alice")).length, 0);
});

test("disconnect rejects foreign grants and large accounts before destructive changes", async () => {
  for (const page of [
    { items: [{ id: "foreign", userId: "google-bob" }] },
    { items: [], cursor: "next" },
  ]) {
    const db = fakeDatabase(); let revoked = false;
    await assert.rejects(disconnectGoogleAccount({
      googleSub: "alice", googleRefreshToken: "refresh", db,
      oauth: { async listUserGrants() { return page; } },
      async revokeGoogleToken() { revoked = true; },
    }));
    assert.equal(revoked, false);
    assert.equal(db.records.length, 2);
  }
});

test("disconnect keeps data and MCP grants when Google revocation fails", async () => {
  const db = fakeDatabase(); let revokedGrant = false;
  await assert.rejects(disconnectGoogleAccount({
    googleSub: "alice", googleRefreshToken: "refresh", db,
    oauth: { async listUserGrants(userId) { return { items: [{ id: "grant", userId }] }; }, async revokeGrant() { revokedGrant = true; } },
    async revokeGoogleToken() { throw new Error("Google unavailable"); },
  }), /Google unavailable/);
  assert.equal(revokedGrant, false);
  assert.equal(db.records.length, 2);
});

test("disconnect refuses missing grants and attempts cleanup of all grants on partial failure", async () => {
  const db = fakeDatabase();
  await assert.rejects(disconnectGoogleAccount({
    googleSub: "alice", googleRefreshToken: "refresh", db,
    oauth: { async listUserGrants() { return { items: [] }; } },
    async revokeGoogleToken() { throw new Error("Must not be called"); },
  }), /No active MCP grant/);
  assert.equal(db.records.length, 2);

  const revoked = [];
  await assert.rejects(disconnectGoogleAccount({
    googleSub: "alice", googleRefreshToken: "refresh", db,
    oauth: {
      async listUserGrants(userId) { return { items: [{ id: "bad", userId }, { id: "good", userId }] }; },
      async revokeGrant(id) { revoked.push(id); if (id === "bad") throw new Error("KV error"); },
    },
    async revokeGoogleToken() {},
  }), /some MCP sessions/);
  assert.deepEqual(revoked, ["bad", "good"]);
});

test("OAuth policy has stable resource scope; settings UI uses two-step confirmation", () => {
  const policy = oauthOptions({}, {}, "https://example.com/mcp");
  assert.deepEqual(policy.requiredScopes, ["cws:read", "offline_access"]);
  assert.equal(policy.resourceMetadata.resource, "https://example.com/mcp");
  assert.match(SETUP_HTML, /disconnect_google_account/);
  assert.match(SETUP_HTML, /Confirm disconnection/);
  assert.doesNotMatch(SETUP_HTML, /innerHTML\s*=/);
});
