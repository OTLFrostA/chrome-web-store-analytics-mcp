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
