import { googleOAuthUserId } from "./google.js";

export function oauthOptions(apiHandler, defaultHandler, resource) {
  return {
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientRegistrationTTL: 7 * 24 * 60 * 60,
    scopesSupported: ["cws:read", "offline_access"],
    requiredScopes: ["cws:read", "offline_access"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource,
      authorization_servers: [new URL(resource).origin],
    },
  };
}

export function authorizedGoogleIdentity(ctx) {
  const sub = ctx?.props?.googleSub;
  return typeof sub === "string" && !!sub &&
    ctx?.auth?.userId === googleOAuthUserId(sub);
}
