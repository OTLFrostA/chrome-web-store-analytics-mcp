import { env } from "cloudflare:workers";
import OAuthProvider, { AuthorizationError, authorizationErrorRedirect, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { mcpHandler } from "./server.js";
import { escapeHtml } from "./validation.js";
import { publicPage } from "./public-pages.js";
import { makeCodeVerifier, googleAuthorizeUrl, exchangeCode, fetchGoogleIdentity, googleOAuthUserId } from "./google.js";
import { oauthOptions, authorizedGoogleIdentity } from "./oauth-options.js";
import { protectRegistration } from "./registration.js";
import { handleCollectionSchedule } from "./collection/runner.js";
import { completeSourceOAuth } from './source-oauth.js';

function consentPage(details, handle) {
  const client = escapeHtml(details.clientName);
  const domain = details.clientDomain ? "Verified client domain: " + escapeHtml(details.clientDomain) :
    "The client name is self-declared; verify the receiving app before approving.";
  const scopes = details.scope.map(scope =>
    '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope) +
    '" checked> ' + escapeHtml(scope) + '</label>'
  ).join("<br>");
  return [
    "<!doctype html><html lang=en><head><meta charset=utf-8>",
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Connect Chrome Web Store Analytics</title>",
    "<style>body{font:16px system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:20px;line-height:1.6}",
    "main{padding:24px;border:1px solid #ddd;border-radius:12px}button{font:inherit;padding:10px 20px;cursor:pointer}",
    "label{display:block;margin:8px 0}small{color:#555}</style></head><body><main>",
    "<h1>Connect Chrome Web Store Analytics</h1>",
    "<p><strong>" + client + "</strong> wants to read Chrome Web Store statistics on your behalf.</p>",
    "<p><small>" + domain + "</small></p>",
    "<p>The connection will return to <strong>" + escapeHtml(details.redirectHost) + "</strong>.</p>",
    details.redirectIsLoopback ? "<p><strong>This sends access to an application on your computer.</strong></p>" : "",
    "<p>You will be redirected to Google to approve read-only Chrome Web Store access. No publishing permissions are requested.</p>",
    '<form method="post"><input type="hidden" name="handle" value="' + escapeHtml(handle) + '">',
    scopes,
    '<p><button type="submit" name="decision" value="approve">Continue to Google</button> ',
    '<button type="submit" name="decision" value="deny">Cancel</button></p></form></main></body></html>',
  ].join("");
}

async function authorize(request, bindings) {
  const oauth = bindings.OAUTH_PROVIDER;
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const transaction = await oauth.beginConsent(authRequest);
    const headers = new Headers(transaction.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, transaction.handle), { headers });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const handle = form.get("handle");
    if (typeof handle !== "string" || !handle) return new Response("Missing consent handle", { status: 400 });
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
    const verifier = makeCodeVerifier();
    const transaction = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const headers = new Headers(transaction.headers);
    headers.set("Location", await googleAuthorizeUrl(bindings,
      new URL("/callback", request.url).href, transaction.state, verifier));
    return new Response(null, { status: 302, headers });
  }
  return new Response("Method not allowed", { status: 405 });
}

async function callback(request, bindings) {
  const oauth = bindings.OAUTH_PROVIDER;
  const transaction = await oauth.finishUpstream(request);
  const headers = new Headers(transaction.headers);
  const url = new URL(request.url);
  if (url.searchParams.has("error") || !url.searchParams.has("code")) {
    headers.set("Location", authorizationErrorRedirect(transaction.request, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const token = await exchangeCode(bindings, new URL("/callback", request.url).href,
    url.searchParams.get("code"), transaction.data.verifier);
  const identity = await fetchGoogleIdentity(token.access_token);
  const authorized = await oauth.completeAuthorization({
    request: transaction.request,
    userId: googleOAuthUserId(identity.sub),
    metadata: { label: identity.email },
    scope: transaction.request.scope,
    props: {
      googleSub: identity.sub,
      googleEmail: identity.email,
      googleRefreshToken: token.refresh_token,
    },
  });
  headers.set("Location", authorized.redirectTo);
  return new Response(null, { status: 302, headers });
}

const handler = {
  async fetch(request, bindings) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize") return await authorize(request, bindings);
      if (url.pathname === "/callback" && request.method === "GET") return await callback(request, bindings);
      if (url.pathname === '/source-oauth/callback' && request.method === 'GET') {
        try {
          const completed=await completeSourceOAuth(request,bindings);
          return new Response('Data source authorized: '+completed.sourceId,{
            status:200,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'},
          });
        } catch {
          return new Response('Data source authorization failed. Return to MCP and retry.',{
            status:400,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'},
          });
        }
      }
      if (request.method === "GET" && url.pathname === "/.well-known/openai-apps-challenge") {
        const value = bindings.OPENAI_APPS_CHALLENGE;
        if (typeof value !== "string" || !value.trim()) return new Response("Not configured", { status: 404 });
        return new Response(value, { headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        } });
      }
      if (request.method === "GET") {
        const page = publicPage(url.pathname);
        if (page) return page;
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return new Response(error.description || "Invalid authorization request", { status: 400 });
      }
      console.error("OAuth request failed:", error instanceof Error ? error.name : "unknown");
      return new Response("Authorization failed. Try connecting your Google account again.", { status: 500 });
    }
  },
};

const provider = new OAuthProvider(oauthOptions({
  fetch(request, bindings, ctx) {
    if (!ctx.auth?.scope?.includes("cws:read")) return insufficientScope(ctx.auth, ["cws:read"]);
    if (!authorizedGoogleIdentity(ctx)) {
      return new Response("Authenticated Google account mismatch.", { status: 401 });
    }
    return mcpHandler(request, bindings, ctx);
  },
}, handler, env.MCP_RESOURCE));

export default {
  fetch(request, bindings, ctx) {
    return protectRegistration(request, bindings.GOOGLE_API_RATE_LIMITER,
      guarded => provider.fetch(guarded, bindings, ctx));
  },
  scheduled(controller, bindings, ctx) {
    ctx.waitUntil(handleCollectionSchedule(bindings, controller.scheduledTime)
      .then(result => console.log('Scheduled collection completed:', JSON.stringify(result)))
      .catch(error => console.error('Scheduled collection failed:', error instanceof Error ? error.message : 'unknown')));
  },
};
