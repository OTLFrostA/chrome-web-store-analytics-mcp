import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { parseStoreUrl, parsePublisherId } from "./validation.js";
import { listUserExtensions, saveUserExtension, removeUserExtension, selectUserExtension } from "./storage.js";
import { googleFetch } from "./rate-limit.js";
import { disconnectGoogleAccount } from "./account-service.js";
import { oauthOptions } from "./oauth-options.js";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { queryMetrics, DIMENSIONS } from "./query.js";
import { refreshGoogleAccessToken } from "./google.js";
import { METRICS } from "./metrics.js";
import { SETUP_RESOURCE_URI, SETUP_MIME_TYPE, SETUP_HTML } from "./setup-ui.js";
import { COLLECTORS, enableDailyCollection, disableDailyCollection, runCollection, updateKeywords, pollPendingBrightDataRankings } from "./collection/runner.js";
import { saveBrightDataKey, hasBrightDataKey, deleteBrightDataKey } from "./collection/credentials.js";
import { verifyBrightDataKey, getGoogleSearchBudget, setGoogleSearchMonthlyLimit, updateGoogleSearchKeywords, listGoogleSearchKeywords, getGoogleSearchHistory } from "./collection/brightdata.js";
import { BRIGHTDATA_SETTINGS_URI, BRIGHTDATA_SETTINGS_MIME, BRIGHTDATA_SETTINGS_HTML } from "./brightdata-setup-ui.js";
import { saveQueryMetrics, getMetricHistory, getRankingHistory, deleteExtensionHistory } from "./collection/history.js";

const securitySchemes = [{ type: "oauth2", scopes: ["cws:read"] }];

function result(data) {
  return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : "Unknown request failure";
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function withErrors(operation) {
  try { return await operation(); } catch (error) { return errorResult(error); }
}

function authProps() {
  const props = getMcpAuthContext()?.props;
  if (!props || typeof props.googleSub !== "string" || typeof props.googleRefreshToken !== "string") {
    throw new Error("Please connect your Google account before using Chrome Web Store Analytics.");
  }
  return props;
}

async function userExtensions(sub) {
  return listUserExtensions(env.MCP_DB, sub);
}

function createServer() {
  const server = new McpServer({ name: "Chrome Web Store Analytics", version: "0.4.0" });

  server.registerResource("extension-settings", SETUP_RESOURCE_URI, {
    title: "Chrome Web Store Analytics — Extension Settings",
    description: "Interactive form for linking and managing Chrome Web Store extensions.",
    mimeType: SETUP_MIME_TYPE,
    _meta: { ui: {} },
  }, async () => ({
    contents: [{
      uri: SETUP_RESOURCE_URI,
      mimeType: SETUP_MIME_TYPE,
      text: SETUP_HTML,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
      },
    }],
  }));

  server.registerResource("brightdata-settings", BRIGHTDATA_SETTINGS_URI, {
    title: "Your private Bright Data key settings",
    description: "Configure a private, user-owned Bright Data key for Google Search rank monitoring.",
    mimeType: BRIGHTDATA_SETTINGS_MIME,
    _meta: { ui: {} },
  }, async () => ({
    contents: [{
      uri: BRIGHTDATA_SETTINGS_URI, mimeType: BRIGHTDATA_SETTINGS_MIME,
      text: BRIGHTDATA_SETTINGS_HTML,
      _meta: { ui: { prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } },
    }],
  }));

  server.registerTool("open_brightdata_settings", {
    title: "Manage your private Bright Data key",
    description: "Open a password-entry settings form to securely configure or remove your personal Bright Data API key. Use this instead of asking the user to paste secrets into chat. Other users never share this key.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
    _meta: { ui: { resourceUri: BRIGHTDATA_SETTINGS_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] } },
  }, async () => withErrors(async () => {
    const props = authProps();
    return result({ configured: await hasBrightDataKey(env, props.googleSub),
      nextStep: "Use the private form to add, rotate, or remove your Bright Data key." });
  }));

  server.registerTool("open_extension_settings", {
    title: "Manage Chrome Web Store extensions",
    description: "Open the interactive extension settings panel to connect a Chrome Web Store extension or manage saved extensions. The form asks for the public Store URL and Publisher ID or publisher-specific Developer Dashboard URL, verifies access with Google, and saves settings for this Google account. Use this when the user asks to configure, link, or manage extensions. If the client cannot display a UI, ask for the Store URL and Publisher ID or publisher-specific Dashboard URL and use connect_extension instead.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
    _meta: {
      ui: { resourceUri: SETUP_RESOURCE_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
  }, async () => withErrors(async () => {
    const props = authProps();
    return result({
      email: props.googleEmail || "",
      extensions: await userExtensions(props.googleSub),
      nextStep: "Use the form to connect or remove extensions.",
    });
  }));

  server.registerTool("get_profile", {
    title: "Connected Google profile",
    description: "Return the Google account used for Chrome Web Store Analytics. The stable id distinguishes connected accounts.",
    inputSchema: {},
    outputSchema: { id: z.string(), email: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
    _meta: { "openai/profile": true },
  }, async () => withErrors(async () => {
    const props = authProps();
    return result({ id: "google:" + props.googleSub, email: props.googleEmail || "" });
  }));

  server.registerTool("list_extensions", {
    title: "List connected extensions",
    description: "List Chrome extensions already linked to this Google account. If empty, call open_extension_settings to show the interactive setup form. If UI is unavailable, ask for the Store extension URL and Publisher ID or publisher-specific Dashboard URL, then use connect_extension.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    const extensions = await userExtensions(props.googleSub);
    return result({ extensions, nextStep: extensions.length ? null :
      "Open the interactive setup using open_extension_settings, or request the Store URL and Publisher ID or publisher-specific Dashboard URL for connect_extension in text-only clients." });
  }));

  server.registerTool("connect_extension", {
    title: "Connect a Chrome Web Store extension",
    description: "Link an extension to the authenticated Google account. Request the public Chrome Web Store extension URL and either the Publisher ID or publisher-specific Developer Dashboard URL (https://chrome.google.com/webstore/devconsole/<PUBLISHER_ID>/settings). Users can open https://chrome.google.com/webstore/developer/dashboard, select their publisher, then visit Publisher > Settings to obtain either value; the generic homepage URL alone is not sufficient. Validates actual Google metrics API access before saving. Never ask for OAuth Playground, keys or passwords.",
    inputSchema: {
      storeUrl: z.string().describe("Public Chrome Web Store extension detail page URL"),
      publisherId: z.string().describe("Publisher ID or publisher-specific Developer Dashboard URL. Open the Dashboard, select your publisher and go to Publisher > Settings; do not submit the generic Dashboard homepage URL."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ storeUrl, publisherId }) => withErrors(async () => {
    const props = authProps();
    const parsed = parseStoreUrl(storeUrl);
    const id = parsePublisherId(publisherId);
    const request = googleFetch(env.GOOGLE_API_RATE_LIMITER, props.googleSub);
    const token = await refreshGoogleAccessToken(env, props.googleRefreshToken, request);
    await queryMetrics(token, id, parsed.itemId, "installs", "overall", 2, request);
    await saveUserExtension(env.MCP_DB, props.googleSub, { itemId: parsed.itemId, publisherId: id, storeUrl: parsed.storeUrl });
    return result({ connected: true, publisherId: id, itemId: parsed.itemId, storeUrl: parsed.storeUrl });
  }));

  server.registerTool("query_metrics", {
    title: "Query extension analytics",
    description: "Read Chrome Web Store extension analytics for the selected registered extension. Install counts, uninstalls, active users, impressions and page views; dates exclude today due to reporting lag. The API does not provide search keywords. If multiple extensions are connected, ask which itemId to use.",
    inputSchema: {
      itemId: z.string().optional().describe("Extension ID; optional only when exactly one extension is connected"),
      metric: z.enum(METRICS).describe("One supported Chrome Web Store metric"),
      dimension: z.enum(DIMENSIONS).default("overall").describe("Breakdown, or overall for all users"),
      days: z.number().int().min(1).max(90).default(14).describe("Number of complete UTC days, ending yesterday (max 90)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ itemId, metric, dimension, days }) => withErrors(async () => {
    const props = authProps();
    const extensions = await userExtensions(props.googleSub);
    const chosen = selectUserExtension(extensions, itemId);
    const request = googleFetch(env.GOOGLE_API_RATE_LIMITER, props.googleSub);
    const token = await refreshGoogleAccessToken(env, props.googleRefreshToken, request);
    const data = await queryMetrics(token, chosen.publisherId, chosen.itemId, metric, dimension, days, request);
    const subscription = await env.MCP_DB.prepare('SELECT enabled FROM collector_subscriptions WHERE google_sub=?')
      .bind(props.googleSub).first();
    if (subscription?.enabled) await saveQueryMetrics(env.MCP_DB, props.googleSub, data);
    return result(data);
  }));

  server.registerTool('set_brightdata_key', {
    title: 'Verify and securely save your Bright Data key',
    description: 'Stores a user-supplied Bright Data API key encrypted in KV, isolated by authenticated Google account. Prefer open_brightdata_settings so the user can enter the key privately instead of posting it in chat. Bright Data account verification uses no search credits.',
    inputSchema: { apiKey: z.string().min(16).max(512) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, securitySchemes,
  }, async ({ apiKey }) => withErrors(async () => {
    const props = authProps();
    const verified = await verifyBrightDataKey(apiKey);
    await saveBrightDataKey(env, props.googleSub, apiKey);
    return result({ configured: true, ...verified });
  }));

  server.registerTool('remove_brightdata_key', {
    title: 'Remove personal Bright Data key',
    description: 'Delete only the authenticated user\'s encrypted Bright Data key. Google Search collection pauses, and historical ranks remain.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    await deleteBrightDataKey(env, props.googleSub);
    return result({ configured: false });
  }));

  server.registerTool('get_brightdata_status', {
    title: 'Check private Bright Data configuration',
    description: 'Return whether a personal Bright Data API key is stored and the account's local monthly keyword-record budget; never return the key.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    const [configured, budget] = await Promise.all([
      hasBrightDataKey(env, props.googleSub), getGoogleSearchBudget(env.MCP_DB, props.googleSub),
    ]);
    return result({ configured, ...budget });
  }));

  server.registerTool('set_brightdata_monthly_limit', {
    title: 'Set personal Bright Data monthly budget',
    description: 'Cap Google keyword snapshot records per Pacific calendar month across the account's connected extensions (1–5000, default 200). This is a local safety cap, not the provider's shared free-tier balance.',
    inputSchema: { monthlyLimit: z.number().int().min(1).max(5000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ monthlyLimit }) => withErrors(async () => {
    const props = authProps();
    return result(await setGoogleSearchMonthlyLimit(env.MCP_DB, props.googleSub, monthlyLimit));
  }));

  server.registerTool('set_google_search_keywords', {
    title: 'Set Google organic search ranking keywords',
    description: 'Replace this extension\'s Google Search / Bright Data keywords (not Chrome Web Store internal search). 0 to 100 phrases, configured at runtime per account and extension. Empty list stops Google rank tracking and retains history. A personal Bright Data key is required to collect.',
    inputSchema: { itemId: z.string().optional(),
      keywords: z.array(z.string().min(1).max(120)).max(100) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, keywords }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      keywords: await updateGoogleSearchKeywords(env.MCP_DB, props.googleSub, item.itemId, keywords) });
  }));

  server.registerTool('get_google_search_history', {
    title: 'Read saved Google organic search ranks',
    description: 'Read historical Bright Data Google organic search positions separately from Chrome Web Store internal search ranks. Scoped to the authenticated Google account and selected extension.',
    inputSchema: { itemId: z.string().optional(), days: z.number().int().min(1).max(365).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, days }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      rows: await getGoogleSearchHistory(env.MCP_DB, props.googleSub, item.itemId, days) });
  }));

  server.registerTool('enable_daily_collection', {
    title: 'Enable 8 AM Pacific collection',
    description: 'Opt in to daily 8:00 AM Pacific collection of CWS analytics, internal Web Store ranking, and optional Google Search ranking with a personal Bright Data key. It submits asynchronous Top-100 snapshots; results are saved when snapshot polling completes. Stores an AES-GCM encrypted Google refresh token for scheduled Analytics use. Historical data stays in D1 until deleted.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    if (!(await userExtensions(props.googleSub)).length) throw new Error('Connect at least one extension first.');
    return result(await enableDailyCollection(env, props.googleSub, props.googleRefreshToken));
  }));

  server.registerTool('disable_daily_collection', {
    title: 'Disable scheduled collection',
    description: 'Stop future daily collection and erase the separate scheduled Google credential. Stored history remains until the extension or account is removed.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    return result(await disableDailyCollection(env, props.googleSub));
  }));

  server.registerTool('collect_now', {
    title: 'Collect CWS metrics or keyword rankings now',
    description: 'Run one or all collectors on demand: cws-analytics, cws-ranking (Chrome Web Store search), or google-search-ranking (Bright Data organic Google results, requires a personal key and configured keywords). Google ranking runs are submitted asynchronously and saved to D1 when ready.',
    inputSchema: {
      itemId: z.string().optional(),
      taskId: z.enum(['all', ...Object.keys(COLLECTORS)]).default('all'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, securitySchemes,
  }, async ({ itemId, taskId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const tasks = taskId === 'all' ? Object.keys(COLLECTORS) : [taskId];
    return result({ itemId: item.itemId, runs: await runCollection({
      env, googleSub: props.googleSub, item, tasks, refreshToken: props.googleRefreshToken,
    }) });
  }));

  server.registerTool('refresh_google_search_rankings', {
    title: 'Refresh pending Bright Data Google search snapshots',
    description: 'Check submitted async Bright Data snapshots for the selected extension, persist completed rankings to D1 and report statuses. Does not submit any new keyword searches or consume new scraper records.',
    inputSchema: { itemId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId, runs: await pollPendingBrightDataRankings({
      env, googleSub: props.googleSub, itemId: item.itemId,
    }) });
  }));

  server.registerTool('set_ranking_keywords', {
    title: 'Set Chrome Web Store search keywords',
    description: 'Replace the tracked CWS search keywords (0 to 20) for this extension only. Keywords are stored in D1 per Google account and extension; passing [] clears the list and stops ranking collection until configured again. Analytics collection is unaffected. Locale is currently en-US.',
    inputSchema: { itemId: z.string().optional(), keywords: z.array(z.string().min(1).max(120)).max(20) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, keywords }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId, keywords: await updateKeywords(env.MCP_DB, props.googleSub, item.itemId, keywords) });
  }));

  server.registerTool('get_saved_metrics', {
    title: 'Read saved Chrome Web Store analytics history',
    description: 'Query stored metric history scoped to the authenticated Google account.',
    inputSchema: {
      itemId: z.string().optional(), metric: z.enum(METRICS),
      dimension: z.enum(DIMENSIONS).default('overall'), days: z.number().int().min(1).max(365).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, metric, dimension, days }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId, rows: await getMetricHistory(env.MCP_DB, props.googleSub, item.itemId, metric, dimension, days) });
  }));

  server.registerTool('get_ranking_history', {
    title: 'Read saved CWS search keyword ranks',
    description: 'Return Chrome Web Store ranking history for a linked extension, including missing ranks outside the inspected top results.',
    inputSchema: { itemId: z.string().optional(), days: z.number().int().min(1).max(365).default(30) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, days }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId, rows: await getRankingHistory(env.MCP_DB, props.googleSub, item.itemId, days) });
  }));

  server.registerTool('get_collection_status', {
    title: 'Read scheduled collector configuration and recent runs',
    description: 'Show daily collection status, separate Chrome Web Store and Google Search keyword configurations, private Bright Data key presence, local monthly budget and last 30 task runs.',
    inputSchema: { itemId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const [subscription, runs, keywords, googleKeywords, brightDataConfigured, budget] = await Promise.all([
      env.MCP_DB.prepare('SELECT enabled, updated_at AS updatedAt FROM collector_subscriptions WHERE google_sub=?')
        .bind(props.googleSub).first(),
      env.MCP_DB.prepare('SELECT run_id AS runId, task_id AS taskId, date, trigger_kind AS trigger, status, rows_written AS rowsWritten, error_message AS error, started_at AS startedAt FROM collector_runs WHERE google_sub=? AND item_id=? ORDER BY started_at DESC LIMIT 30')
        .bind(props.googleSub, item.itemId).all(),
      env.MCP_DB.prepare('SELECT keyword, locale FROM collector_keywords WHERE google_sub=? AND item_id=? ORDER BY keyword')
        .bind(props.googleSub, item.itemId).all(),
      listGoogleSearchKeywords(env.MCP_DB, props.googleSub, item.itemId),
      hasBrightDataKey(env, props.googleSub),
      getGoogleSearchBudget(env.MCP_DB, props.googleSub),
    ]);
    return result({ itemId: item.itemId, enabled: !!subscription?.enabled, time: '08:00 America/Los_Angeles',
      collectors: Object.keys(COLLECTORS), keywords: keywords.results ?? [],
      googleSearchKeywords: googleKeywords, brightDataConfigured, brightDataBudget: budget,
      runs: runs.results ?? [] });
  }));

  server.registerTool("remove_extension", {
    title: "Remove a connected extension",
    description: "Remove this extension from this account's saved configuration. This does not delete or modify the extension in Google.",
    inputSchema: { itemId: z.string().describe("Extension ID to unlink from ChatGPT") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const linked = selectUserExtension(await userExtensions(props.googleSub), itemId);
    await deleteExtensionHistory(env.MCP_DB, props.googleSub, linked.itemId);
    return result({ removed: await removeUserExtension(env.MCP_DB, props.googleSub, linked.itemId) });
  }));

  server.registerTool("disconnect_google_account", {
    title: "Disconnect Google and delete account data",
    description: "Irreversibly revoke this Google account's OAuth authorization, delete all linked extensions, and revoke all its MCP grants. Call only after the user explicitly confirms. Google revocation may invalidate other authorizations for the same Google Cloud project. Reconnecting to the MCP will be required.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes,
  }, async () => withErrors(async () => {
    const props = authProps();
    // Construct the same OAuth grant policy with inert HTTP handlers; only
    // its protected KV-backed grant helpers are used in this operation.
    const inert = { fetch: () => new Response("Not found", { status: 404 }) };
    const oauth = getOAuthApi(oauthOptions(inert, inert, env.MCP_RESOURCE), env);
    return result(await disconnectGoogleAccount({
      googleSub: props.googleSub,
      googleRefreshToken: props.googleRefreshToken,
      db: env.MCP_DB,
      oauth,
      collectionEnv: env,
    }));
  }));

  return server;
}

export const mcpHandler = createMcpHandler(createServer);
