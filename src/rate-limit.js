export async function enforceGoogleRateLimit(limiter, googleSub) {
  if (!limiter || typeof limiter.limit !== "function") {
    throw new Error("Google API rate limiter is not configured.");
  }
  const { success } = await limiter.limit({ key: "google:" + googleSub });
  if (!success) {
    throw new Error("Too many Google API requests. Please retry in about a minute.");
  }
}

// Count each outgoing request, including token refresh and every metrics page.
export function googleFetch(limiter, googleSub, request = fetch) {
  return async (url, options) => {
    await enforceGoogleRateLimit(limiter, googleSub);
    return request(url, options);
  };
}
