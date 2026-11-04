// A separate encrypted credential is needed because scheduled() has no MCP OAuth
// request context. This entry is opt-in and erased when collection is disabled.
const PREFIX = 'scheduled-collection:credential:v1:';

function bytesFromBase64(encoded) {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function aesKey(secret) {
  if (typeof secret !== 'string') throw new Error('SCHEDULE_TOKEN_KEY secret is not configured.');
  let bytes;
  try { bytes = bytesFromBase64(secret); } catch { throw new Error('Invalid SCHEDULE_TOKEN_KEY encoding.'); }
  if (bytes.length !== 32) throw new Error('SCHEDULE_TOKEN_KEY must be a base64-encoded 32-byte key.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function saveCollectorCredential(env, googleSub, refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Missing Google refresh token.');
  const key = await aesKey(env.SCHEDULE_TOKEN_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(googleSub),
  }, key, new TextEncoder().encode(refreshToken));
  await env.OAUTH_KV.put(PREFIX + googleSub, JSON.stringify({
    version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)),
  }));
}

export async function readCollectorCredential(env, googleSub) {
  const record = await env.OAUTH_KV.get(PREFIX + googleSub, 'json');
  if (!record) throw new Error('Scheduled Google authorization is missing; enable collection from your MCP account.');
  if (record.version !== 1) throw new Error('Unsupported scheduled credential version.');
  const key = await aesKey(env.SCHEDULE_TOKEN_KEY);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytesFromBase64(record.iv),
    additionalData: new TextEncoder().encode(googleSub),
  }, key, bytesFromBase64(record.ciphertext));
  return new TextDecoder().decode(plaintext);
}

export async function deleteCollectorCredential(env, googleSub) {
  await env.OAUTH_KV.delete(PREFIX + googleSub);
}


// User-owned Bright Data credentials stay encrypted in KV, account-bound via AES-GCM.
// No shared provider key or secret is ever stored in D1 or returned over MCP.
const BRIGHTDATA_PREFIX = 'user-brightdata:credential:v1:';
const LEGACY_SERPAPI_PREFIX = 'user-serpapi:credential:v1:';
function brightDataAAD(googleSub) {
  return new TextEncoder().encode('brightdata-key:v1:' + googleSub);
}

export async function saveBrightDataKey(env, googleSub, apiKey) {
  if (typeof googleSub !== 'string' || !googleSub) throw new Error('Missing authenticated Google account.');
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9._~+-]{16,512}$/.test(apiKey)) {
    throw new Error('Invalid Bright Data API token format.');
  }
  const key = await aesKey(env.SCHEDULE_TOKEN_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: brightDataAAD(googleSub),
  }, key, new TextEncoder().encode(apiKey));
  await env.OAUTH_KV.put(BRIGHTDATA_PREFIX + googleSub, JSON.stringify({
    version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)),
  }));
  // Once the replacement is securely saved, remove obsolete encrypted SerpAPI data.
  await env.OAUTH_KV.delete(LEGACY_SERPAPI_PREFIX + googleSub);
}

export async function readBrightDataKey(env, googleSub) {
  const record = await env.OAUTH_KV.get(BRIGHTDATA_PREFIX + googleSub, 'json');
  if (!record) return null;
  if (record.version !== 1) throw new Error('Unsupported Bright Data credential version.');
  const key = await aesKey(env.SCHEDULE_TOKEN_KEY);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytesFromBase64(record.iv), additionalData: brightDataAAD(googleSub),
  }, key, bytesFromBase64(record.ciphertext));
  return new TextDecoder().decode(plaintext);
}

export async function hasBrightDataKey(env, googleSub) {
  return !!(await env.OAUTH_KV.get(BRIGHTDATA_PREFIX + googleSub, 'text'));
}

export async function deleteBrightDataKey(env, googleSub) {
  await env.OAUTH_KV.delete(BRIGHTDATA_PREFIX + googleSub);
  await env.OAUTH_KV.delete(LEGACY_SERPAPI_PREFIX + googleSub);
}
