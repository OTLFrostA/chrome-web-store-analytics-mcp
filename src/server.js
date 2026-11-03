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
  const server = new McpServer({ name: "Chrome Web Store Analytics", version: "0.2.0" });

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
    return result(await queryMetrics(token, chosen.publisherId, chosen.itemId, metric, dimension, days, request));
  }));

  server.registerTool("remove_extension", {
    title: "Remove a connected extension",
    description: "Remove this extension from this account's saved configuration. This does not delete or modify the extension in Google.",
    inputSchema: { itemId: z.string().describe("Extension ID to unlink from ChatGPT") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes,
  }, async ({ itemId }) => withErrors(async () => {
    const props = authProps();
    return result({ removed: await removeUserExtension(env.MCP_DB, props.googleSub, itemId) });
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
    }));
  }));

  return server;
}

export const mcpHandler = createMcpHandler(createServer);
