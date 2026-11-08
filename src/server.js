import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { parseStoreUrl, parsePublisherId } from "./validation.js";
import { listUserExtensions, saveUserExtension, removeUserExtension, selectUserExtension } from "./storage.js";
import { disconnectGoogleAccount } from "./account-service.js";
import { oauthOptions } from "./oauth-options.js";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { DIMENSIONS } from "./query.js";
import { googleQueryAccess, queryAndStoreMetrics, queryAndStoreStatus,
  queryAndStoreRating, queryAndStoreReviewPage, queryAndStoreWebStoreRank } from "./query-service.js";
import { getRatingHistory, getStatusEvents, getWebStoreSearchSnapshots,
  getGoogleSearchSnapshots } from "./collection/snapshots.js";
import { METRICS } from "./metrics.js";
import { SETUP_RESOURCE_URI, SETUP_MIME_TYPE, SETUP_HTML } from "./setup-ui.js";
import { COLLECTORS, enableDailyCollection, disableDailyCollection, runCollection, updateKeywords, pollPendingBrightDataRankings } from "./collection/runner.js";
import { saveBrightDataKey, hasBrightDataKey, deleteBrightDataKey } from "./collection/credentials.js";
import { verifyBrightDataKey, getGoogleSearchBudget, setGoogleSearchMonthlyLimit, updateGoogleSearchKeywords, listGoogleSearchKeywords, getGoogleSearchHistory } from "./collection/brightdata.js";
import { BRIGHTDATA_SETTINGS_URI, BRIGHTDATA_SETTINGS_MIME, BRIGHTDATA_SETTINGS_HTML } from "./brightdata-setup-ui.js";
import { readKeywordSettings, saveKeywordSettings } from "./collection/keyword-settings.js";
import { getReviewSettings, setReviewSettings, getSavedReviews } from "./collection/reviews.js";
import { getMetricHistory, getRankingHistory, deleteExtensionHistory } from "./collection/history.js";
import { createDataSource, listDataSources, getDataSource } from './data-sources.js';
import { beginSourceOAuth } from './source-oauth.js';
import { disconnectDataSourceAuthorization } from './authorization-manager.js';
import { resolveAppUser } from './users.js';
import { collectGa4Source, readGa4History } from './collection/ga4.js';
import { setGa4DailyCollection } from './collection/ga4-schedule.js';

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

async function authenticatedOwnerId() {
  const ctx=getMcpAuthContext();
  const props=authProps();
  const identity=ctx?.auth?.userId;
  if(typeof identity!=='string'||identity!=='google-'+props.googleSub)
    throw new Error('Authenticated user identity mismatch.');
  return resolveAppUser(env.MCP_DB,{identityProvider:'mcp',identitySubject:identity});
}

async function userExtensions(sub) {
  return listUserExtensions(env.MCP_DB, sub);
}

function createServer() {
  const server = new McpServer({ name: "Chrome Web Store Analytics", version: "0.5.1" });

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
    title: "Bright Data and keyword monitoring settings",
    description: "Manage a private Bright Data key and per-extension Google / Chrome Web Store keyword monitoring.",
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
    title: "Manage Bright Data and ranking keywords",
    description: "Open the unified private settings form to manage a personal Bright Data key and add, remove, pause or resume Google Search and Chrome Web Store keywords for each linked extension. Never paste API tokens into chat.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
    _meta: { ui: { resourceUri: BRIGHTDATA_SETTINGS_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] } },
  }, async () => withErrors(async () => {
    const props = authProps();
    return result({ configured: await hasBrightDataKey(env, props.googleSub),
      nextStep: "Use the private form to manage the Bright Data key and both keyword lists for your connected extensions." });
  }));

  server.registerTool("open_keyword_settings", {
    title: "Manage Google and Chrome Web Store ranking keywords",
    description: "Open the unified keyword settings UI to add, remove, pause or resume ranking keywords independently for each linked extension. Includes a private Bright Data key panel.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes,
    _meta: { ui: { resourceUri: BRIGHTDATA_SETTINGS_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] } },
  }, async () => withErrors(async () => {
    const props = authProps();
    const extensions = await userExtensions(props.googleSub);
    return result({ extensions: extensions.map(item => ({itemId:item.itemId,storeUrl:item.storeUrl})),
      nextStep: "Use the settings panel to edit either keyword list for a linked extension." });
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

  // Source management is separate from MCP identity and collector execution.
  server.registerTool('list_data_sources', {
    title: 'List owned data sources and their authorization state',
    description: 'List external properties connected by the authenticated MCP user. No credential values are returned.',
    inputSchema: {},
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes,
  }, async()=>withErrors(async()=>{
    const props=authProps();
    return result({sources:await listDataSources(env.MCP_DB,await authenticatedOwnerId())});
  }));

  server.registerTool('register_data_source', {
    title: 'Register an external data source',
    description: 'Create a user-owned data source record. Registration does not grant access or enable collection.',
    inputSchema: {
      sourceType:z.enum(['ga4','cws']),
      externalResourceId:z.string().min(1).max(250),
      displayName:z.string().min(1).max(250),
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async({sourceType,externalResourceId,displayName})=>withErrors(async()=>{
    const props=authProps();
    if(sourceType==='ga4'&&!/^\d{1,30}$/.test(externalResourceId))
      throw new Error('GA4 property must be its numeric property ID.');
    if(sourceType==='cws'&&!/^[a-p]{32}$/.test(externalResourceId))
      throw new Error('CWS resource must be a valid extension ID.');
    return result({source:await createDataSource(env.MCP_DB,{
      ownerUserId:await authenticatedOwnerId(),sourceType,externalResourceId,displayName})});
  }));

  server.registerTool('begin_data_source_oauth', {
    title:'Authorize one data source with Google',
    description:'Start source-specific Google consent with its own scopes, state and PKCE. Returns an authorization URL; completion occurs at the verified server callback. Requires the /source-oauth/callback redirect URI in Google Cloud.',
    inputSchema:{sourceId:z.string().uuid()},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},securitySchemes,
  },async({sourceId})=>withErrors(async()=>{
    const props=authProps();
    return result(await beginSourceOAuth({env,ownerUserId:await authenticatedOwnerId(),sourceId,
      baseUrl:env.MCP_RESOURCE}));
  }));

  server.registerTool('query_ga4', {
    title:'Query GA4 property and save analytics',
    description:'Query a connected GA4 data source for up to 90 property-local reporting days. Saves daily active users, sessions, views, install event counts and session source/medium to D1. Missing install events are null, not zero.',
    inputSchema:{
      sourceId:z.string().uuid(),
      dateFrom:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
      dateTo:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
    },
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},securitySchemes,
  },async({sourceId,dateFrom,dateTo})=>withErrors(async()=>{
    const ownerUserId=await authenticatedOwnerId();
    return result(await collectGa4Source({env,ownerUserId,sourceId,dateFrom,dateTo}));
  }));

  server.registerTool('get_ga4_history', {
    title:'Read saved GA4 analytics',
    description:'Read previously collected GA4 daily totals and channel history from D1 for an owned data source, without calling Google or spending API quota.',
    inputSchema:{
      sourceId:z.string().uuid(),
      dateFrom:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
      dateTo:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
    },
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async({sourceId,dateFrom,dateTo})=>withErrors(async()=>{
    const ownerUserId=await authenticatedOwnerId();
    return result(await readGa4History(env.MCP_DB,{ownerUserId,sourceId,dateFrom,dateTo}));
  }));

  server.registerTool('set_ga4_daily_collection', {
    title:'Enable or disable daily GA4 collection',
    description:'Opt in or out of 9 AM Pacific collection with a rolling seven-day refresh. The data source must be independently authorized; disabling preserves collected history.',
    inputSchema:{sourceId:z.string().uuid(),enabled:z.boolean()},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async({sourceId,enabled})=>withErrors(async()=>{
    const ownerUserId=await authenticatedOwnerId();
    return result(await setGa4DailyCollection(env.MCP_DB,{ownerUserId,sourceId,enabled}));
  }));

  server.registerTool('disconnect_data_source', {
    title:'Disconnect authorization for a single data source',
    description:'Delete only this source credential and authorization metadata; does not revoke Google-wide consent or delete saved metrics. To revoke provider-wide access, use Google Account settings.',
    inputSchema:{sourceId:z.string().uuid()},
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},securitySchemes,
  },async({sourceId})=>withErrors(async()=>{
    const props=authProps();
    await getDataSource(env.MCP_DB,await authenticatedOwnerId(),sourceId);
    return result(await disconnectDataSourceAuthorization({env,
      ownerUserId:await authenticatedOwnerId(),sourceId}));
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
    const access = await googleQueryAccess({env,googleSub:props.googleSub,refreshToken:props.googleRefreshToken});
    await queryAndStoreMetrics({
      db:env.MCP_DB,googleSub:props.googleSub,
      item:{publisherId:id,itemId:parsed.itemId},metric:"installs",dimension:"overall",
      days:2,token:access.token,request:access.request,
    });
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ itemId, metric, dimension, days }) => withErrors(async () => {
    const props = authProps();
    const extensions = await userExtensions(props.googleSub);
    const chosen = selectUserExtension(extensions, itemId);
    const access = await googleQueryAccess({env,googleSub:props.googleSub,refreshToken:props.googleRefreshToken});
    return result(await queryAndStoreMetrics({
      db:env.MCP_DB,googleSub:props.googleSub,item:chosen,metric,dimension,days,
      token:access.token,request:access.request,
    }));
  }));

  server.registerTool("get_extension_status", {
    title: "Read extension publishing and review status",
    description: "Read official Chrome Web Store status for a connected extension: published and submitted revisions, version and rollout information, async upload state, and policy warnings. Does not publish or modify anything.",
    inputSchema: {
      itemId: z.string().optional().describe("Extension ID; omit only when exactly one is connected"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const chosen = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const access = await googleQueryAccess({env,googleSub:props.googleSub,refreshToken:props.googleRefreshToken});
    return result(await queryAndStoreStatus({db:env.MCP_DB,googleSub:props.googleSub,
      item:chosen,token:access.token,request:access.request}));
  }));

  server.registerTool("get_rating_summary", {
    title: "Read Chrome Web Store rating summary",
    description: "Read the official average rating, total rating count, written review count, and 1–5 star distribution of a connected extension. Read-only and live from Google.",
    inputSchema: {
      itemId: z.string().optional().describe("Extension ID; omit only when exactly one is connected"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const chosen = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const access = await googleQueryAccess({env,googleSub:props.googleSub,refreshToken:props.googleRefreshToken});
    return result(await queryAndStoreRating({db:env.MCP_DB,googleSub:props.googleSub,
      item:chosen,token:access.token,request:access.request}));
  }));

  server.registerTool("fetch_reviews", {
    title: "Fetch live Chrome Web Store reviews",
    description: "Read reviews directly from Google's official API, with pagination, optional star-rating filter and ordering. This does not require or change daily collection. Use get_saved_reviews for previously collected history.",
    inputSchema: {
      itemId: z.string().optional().describe("Extension ID; omit only when exactly one is connected"),
      pageSize: z.number().int().min(1).max(200).default(50),
      pageToken: z.string().min(1).max(4096).optional().describe("Continuation token from the previous page"),
      rating: z.number().int().min(1).max(5).optional().describe("Only reviews with this star rating"),
      orderBy: z.enum([
        "createTime desc", "rating asc", "rating desc",
        "rating asc, createTime desc", "rating desc, createTime desc",
        "create_time desc",
      ]).default("createTime desc").describe("Google review sort order; reuse returned orderBy while paging"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes,
  }, async ({ itemId, pageSize, pageToken, rating, orderBy }) => withErrors(async () => {
    const props = authProps();
    const chosen = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const access = await googleQueryAccess({env,googleSub:props.googleSub,refreshToken:props.googleRefreshToken});
    let effectiveOrder = orderBy;
    let page;
    const read = selectedOrder => queryAndStoreReviewPage({
      db:env.MCP_DB,googleSub:props.googleSub,item:chosen,
      token:access.token,pageToken,request:access.request,
      orderBy:selectedOrder,pageSize,rating,
    });
    try { page=await read(orderBy); } catch (error) {
      if (pageToken || orderBy !== "createTime desc" ||
          !(error instanceof Error) || !/HTTP 400_invalid_order/.test(error.message)) throw error;
      effectiveOrder = "create_time desc";
      page = await read(effectiveOrder);
    }
    return result({ publisherId: chosen.publisherId, itemId: chosen.itemId,
      orderBy: effectiveOrder, rating: rating ?? null, ...page });
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
    description: 'Return whether a personal Bright Data API key is stored and the account-wide local monthly keyword-record budget; never return the key.',
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
    description: 'Cap Google keyword snapshot records per Pacific calendar month across all connected extensions in this account (1-5000, default 200). This is a local safety cap, not the shared free-tier balance of the provider.',
    inputSchema: { monthlyLimit: z.number().int().min(1).max(5000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ monthlyLimit }) => withErrors(async () => {
    const props = authProps();
    return result(await setGoogleSearchMonthlyLimit(env.MCP_DB, props.googleSub, monthlyLimit));
  }));

  server.registerTool('get_keyword_settings', {
    title: 'Get configured ranking keywords, including paused entries',
    description: 'Read both Google Search and Chrome Web Store keyword settings (enabled and disabled) for one extension owned by the authenticated Google account. No keys or search history are returned.',
    inputSchema: { itemId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      ...(await readKeywordSettings(env.MCP_DB, props.googleSub, item.itemId)) });
  }));

  server.registerTool('save_keyword_settings', {
    title: 'Save ranking keyword monitoring settings',
    description: 'Replace the selected extension keyword list for Google Search (maximum 100) or Chrome Web Store (maximum 20). Each entry has an explicit enabled flag; disabled entries can be resumed later. Existing ranking history is never deleted.',
    inputSchema: {
      itemId: z.string().optional(),
      engine: z.enum(['google','webstore']),
      entries: z.array(z.object({
        keyword: z.string().min(1).max(120), enabled: z.boolean(),
      })).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, engine, entries }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const saved = await saveKeywordSettings(env.MCP_DB, props.googleSub, item.itemId, engine, entries);
    return result({ itemId: item.itemId, engine, entries: saved });
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
    title: 'Enable daily collection',
    description: 'Opt in to 8 AM Pacific CWS analytics/keyword monitoring and 9 AM official Chrome Web Store review monitoring. Uses your encrypted scheduled Google OAuth credential and optional per-user Bright Data key. Disabling preserves history.',
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
    title: 'Collect CWS metrics, reviews or rankings now',
    description: 'Run one or all collectors on demand: cws-analytics, cws-ranking, google-search-ranking or cws-reviews (official Google API). Google Search submits asynchronous Bright Data jobs; reviews are deduplicated in D1.',
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

  server.registerTool('get_review_collection_settings', {
    title: 'Read per-extension Web Store review collection settings',
    description: 'Read whether official Chrome Web Store review collection is enabled and how many newest-first pages are checked per run. Default: enabled, up to five pages of 200 reviews.',
    inputSchema: { itemId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      ...(await getReviewSettings(env.MCP_DB, props.googleSub, item.itemId)) });
  }));

  server.registerTool('set_review_collection_settings', {
    title: 'Configure per-extension Web Store review collection',
    description: 'Enable or disable official CWS review collection and set the number of newest-first pages (1-10, up to 200 reviews each) per run. Account- and extension-scoped D1 settings; disabled review collection retains its history.',
    inputSchema: {
      itemId: z.string().optional(),
      enabled: z.boolean().optional(),
      maxPages: z.number().int().min(1).max(10).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, enabled, maxPages }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      ...(await setReviewSettings(env.MCP_DB, props.googleSub, item.itemId, {enabled,maxPages})) });
  }));

  server.registerTool('get_saved_reviews', {
    title: 'Read saved Chrome Web Store user reviews',
    description: 'Read reviews from D1, without new requests to Google. Includes rating, comment, author display name, review ID, publication and first-seen times. Filter for first-seen dates to discover newly collected reviews. Account/extension-scoped.',
    inputSchema: {
      itemId: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(100),
      newWithinDays: z.number().int().min(0).max(365).default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId, limit, newWithinDays }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    return result({ itemId: item.itemId,
      reviews: await getSavedReviews(env.MCP_DB, props.googleSub, item.itemId, {limit,newWithinDays}) });
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

  server.registerTool("query_webstore_ranking", {
    title: "Search Chrome Web Store ranking and save results",
    description: "Query current public Chrome Web Store search rankings for a keyword; save the complete ordered result list and this extension's rank in account-scoped history. The underlying Web Store search endpoint is unofficial.",
    inputSchema: { itemId:z.string().optional(),
      keyword:z.string().min(1).max(120),locale:z.string().default("en-US") },
    annotations: { readOnlyHint:false,destructiveHint:false,openWorldHint:true },securitySchemes,
  },async ({itemId,keyword,locale})=>withErrors(async()=>{
    const props=authProps();
    const item=selectUserExtension(await userExtensions(props.googleSub),itemId);
    return result({itemId:item.itemId,...(await queryAndStoreWebStoreRank({
      db:env.MCP_DB,googleSub:props.googleSub,item,keyword,locale,
    }))});
  }));

  server.registerTool("get_rating_history", {
    title:"Read saved Chrome Web Store rating history",
    description:"Read complete daily rating summaries from D1; does not call Google.",
    inputSchema:{itemId:z.string().optional(),days:z.number().int().min(1).max(365).default(90)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async ({itemId,days})=>withErrors(async()=>{
    const props=authProps();
    const item=selectUserExtension(await userExtensions(props.googleSub),itemId);
    return result({itemId:item.itemId,history:await getRatingHistory(env.MCP_DB,props.googleSub,item.itemId,days)});
  }));

  server.registerTool("get_status_history", {
    title:"Read saved publishing, review and policy status changes",
    description:"Read only status transitions from D1, newest first. Does not call Google.",
    inputSchema:{itemId:z.string().optional(),limit:z.number().int().min(1).max(100).default(30)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async ({itemId,limit})=>withErrors(async()=>{
    const props=authProps();
    const item=selectUserExtension(await userExtensions(props.googleSub),itemId);
    return result({itemId:item.itemId,events:await getStatusEvents(env.MCP_DB,props.googleSub,item.itemId,limit)});
  }));

  server.registerTool("get_search_snapshots", {
    title:"Read saved full Web Store and Google search result snapshots",
    description:"Read previously persisted keyword search results from D1 without any provider request. Google organic results are the full Bright Data records; this endpoint never exposes API keys.",
    inputSchema:{itemId:z.string().optional(),source:z.enum(["webstore","google"]),
      days:z.number().int().min(1).max(365).default(30),
      limit:z.number().int().min(1).max(30).default(5)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},securitySchemes,
  },async ({itemId,source,days,limit})=>withErrors(async()=>{
    const props=authProps();
    const item=selectUserExtension(await userExtensions(props.googleSub),itemId);
    const all=source==="webstore"
      ? await getWebStoreSearchSnapshots(env.MCP_DB,props.googleSub,item.itemId,days)
      : await getGoogleSearchSnapshots(env.MCP_DB,props.googleSub,item.itemId,days,limit);
    return result({itemId:item.itemId,source,snapshots:all.slice(0,limit)});
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
    description: 'Read daily collectors, keyword configurations, Bright Data usage, official review settings and recent runs.',
    inputSchema: { itemId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    const item = selectUserExtension(await userExtensions(props.googleSub), itemId);
    const [subscription, runs, keywords, googleKeywords, brightDataConfigured, budget, reviewSettings, reviewCount] = await Promise.all([
      env.MCP_DB.prepare('SELECT enabled, updated_at AS updatedAt FROM collector_subscriptions WHERE google_sub=?')
        .bind(props.googleSub).first(),
      env.MCP_DB.prepare('SELECT run_id AS runId, task_id AS taskId, date, trigger_kind AS trigger, status, rows_written AS rowsWritten, error_message AS error, started_at AS startedAt FROM collector_runs WHERE google_sub=? AND item_id=? ORDER BY started_at DESC LIMIT 30')
        .bind(props.googleSub, item.itemId).all(),
      env.MCP_DB.prepare('SELECT keyword, locale FROM collector_keywords WHERE google_sub=? AND item_id=? ORDER BY keyword')
        .bind(props.googleSub, item.itemId).all(),
      listGoogleSearchKeywords(env.MCP_DB, props.googleSub, item.itemId),
      hasBrightDataKey(env, props.googleSub),
      getGoogleSearchBudget(env.MCP_DB, props.googleSub),
      getReviewSettings(env.MCP_DB, props.googleSub, item.itemId),
      env.MCP_DB.prepare('SELECT COUNT(*) AS count FROM review_history WHERE google_sub=? AND item_id=?')
        .bind(props.googleSub, item.itemId).first(),
    ]);
    return result({ itemId: item.itemId, enabled: !!subscription?.enabled, time: '08:00 America/Los_Angeles',
      collectors: Object.keys(COLLECTORS), reviewTime: '09:00 America/Los_Angeles',
      reviewCollection: { ...reviewSettings, storedCount: reviewCount?.count ?? 0 }, keywords: keywords.results ?? [],
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
