const MAX_REGISTRATION_BYTES = 16 * 1024;

function reject(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
}

// Reuse the existing binding with separate keys, so production needs no new
// resources. Both per-IP and aggregate registration budgets are per location.
export async function protectRegistration(request, limiter, proceed) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/oauth/register") {
    return proceed(request);
  }
  if (!limiter || typeof limiter.limit !== "function") {
    return reject(503, "Registration protection is unavailable");
  }
  try {
    // Cloudflare supplies this header; do not trust a client X-Forwarded-For.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    for (const key of ["registration:ip:" + ip, "registration:all"]) {
      if (!(await limiter.limit({ key })).success) return reject(429, "Too many registration requests");
    }
  } catch {
    return reject(503, "Registration protection is unavailable");
  }
  if (Number(request.headers.get("Content-Length")) > MAX_REGISTRATION_BYTES) {
    return reject(413, "Registration request is too large");
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REGISTRATION_BYTES) {
          await reader.cancel();
          return reject(413, "Registration request is too large");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length < 1 ||
        metadata.redirect_uris.length > 5 || metadata.redirect_uris.some(uri => typeof uri !== "string" || uri.length > 2048) ||
        (metadata.client_name !== undefined && (typeof metadata.client_name !== "string" || metadata.client_name.length > 200))) {
      return reject(400, "Invalid registration metadata");
    }
    const forwarded = new Request(request, { body: bytes });
    return proceed(forwarded);
  } catch {
    return reject(400, "Invalid registration request");
  } finally {
    reader?.releaseLock();
  }
}
