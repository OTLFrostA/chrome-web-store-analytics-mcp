// Account-scoped downstream grants, independent of the MCP client's own OAuth grant.
// Secrets are encrypted at rest. Connection IDs distinguish multiple accounts at one provider.
const PREFIX = 'provider-grant:v1:';

function grantKey(owner, provider, connectionId) {
  for (const value of [owner, provider, connectionId]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._@:-]{1,180}$/.test(value)) {
      throw new TypeError('Invalid provider authorization identifier.');
    }
  }
  return PREFIX + [owner, provider, connectionId].map(encodeURIComponent).join(':');
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function toBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
async function getKey(secret) {
  if (typeof secret !== 'string') throw new Error('Encryption secret is not configured.');
  let raw;
  try { raw = fromBase64(secret); } catch { throw new Error('Invalid encryption secret.'); }
  if (raw.byteLength !== 32) throw new Error('Invalid encryption secret length.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string' || !s || s.length > 512)) {
    throw new TypeError('Invalid provider authorization scopes.');
  }
  return [...new Set(scopes)].sort();
}

// The provider's OAuth redirect flow must verify the subject and consented scopes
// before calling this method. It must never accept a token supplied over MCP chat.
export async function saveProviderGrant(env, { owner, provider, connectionId, token, scopes, kind }) {
  if (!['oauth', 'api-key'].includes(kind) || typeof token !== 'string' || !token) {
    throw new TypeError('Invalid downstream credential.');
  }
  const keyName = grantKey(owner, provider, connectionId);
  const consentedScopes = normalizeScopes(scopes);
  if (kind === 'oauth' && !consentedScopes.length) throw new TypeError('OAuth grant needs scopes.');
  const key = await getKey(env.SCHEDULE_TOKEN_KEY), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(keyName),
  }, key, new TextEncoder().encode(token));
  await env.OAUTH_KV.put(keyName, JSON.stringify({
    version: 1, kind, scopes: consentedScopes,
    iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(cipher)),
  }));
}

// A missing or insufficient grant fails closed; it never falls back to another provider.
export async function readProviderGrant(env, { owner, provider, connectionId, kind, scopes = [] }) {
  const keyName = grantKey(owner, provider, connectionId);
  const required = normalizeScopes(scopes);
  const record = await env.OAUTH_KV.get(keyName, 'json');
  if (!record) throw new Error('Data source is not connected.');
  if (record.version !== 1 || record.kind !== kind || !Array.isArray(record.scopes) ||
    !required.every(scope => record.scopes.includes(scope))) {
    throw new Error('Data source authorization is insufficient. Reconnect this data source.');
  }
  const key = await getKey(env.SCHEDULE_TOKEN_KEY);
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64(record.iv),
    additionalData: new TextEncoder().encode(keyName),
  }, key, fromBase64(record.ciphertext));
  return new TextDecoder().decode(decrypted);
}
export async function deleteProviderGrant(env, { owner, provider, connectionId }) {
  await env.OAUTH_KV.delete(grantKey(owner, provider, connectionId));
}
