export function googleOAuthUserId(sub) {
  if (typeof sub !== "string" || !sub || sub.includes(":")) {
    throw new TypeError("Invalid Google account identifier.");
  }
  return "google-" + sub;
}

const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/chromewebstore.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function makeCodeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function googleAuthorizeUrl(env, callbackUrl, state, verifier) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  return url.toString();
}

async function tokenRequest(params, request = fetch) {
  const response = await request(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new Error("Google authorization failed or was revoked. Reconnect your Google account.");
    }
    throw new Error("Google token service is unavailable (HTTP " + response.status + ").");
  }
  const payload = await response.json();
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Google did not return an access token.");
  }
  return payload;
}

export async function exchangeCode(env, callbackUrl, code, verifier) {
  const token = await tokenRequest({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl,
    grant_type: "authorization_code",
  });
  if (!token.refresh_token) {
    throw new Error("Google did not issue a refresh token. Reconnect and approve offline access.");
  }
  return token;
}

export async function refreshGoogleAccessToken(env, refreshToken, request = fetch) {
  if (!refreshToken) throw new Error("Missing Google authorization. Reconnect your Google account.");
  const token = await tokenRequest({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }, request);
  return token.access_token;
}

export async function fetchGoogleIdentity(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not verify the Google account.");
  const identity = await response.json();
  if (typeof identity.sub !== "string" || !identity.sub || identity.email_verified !== true) {
    throw new Error("The Google account identity is incomplete or its email is not verified.");
  }
  return { sub: identity.sub, email: typeof identity.email === "string" ? identity.email : "" };
}

export async function revokeGoogleRefreshToken(refreshToken, request = fetch) {
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("Missing Google authorization to revoke.");
  }
  const response = await request("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });
  // Google returns HTTP 400 when a token is already invalid or revoked.
  if (!response.ok && response.status !== 400) {
    throw new Error("Google authorization revocation failed (HTTP " + response.status + "). Try again.");
  }
}
