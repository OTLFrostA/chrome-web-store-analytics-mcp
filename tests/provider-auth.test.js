import test from 'node:test';
import assert from 'node:assert/strict';
import { saveProviderGrant, readProviderGrant, deleteProviderGrant } from '../src/collection/provider-credentials.js';
import { AUTH, assertAuthRequirement } from '../src/collection/auth-requirements.js';
import { resolveCollectorAuth } from '../src/collection/auth-resolver.js';

function fakeEnv() {
  const data = new Map();
  return {
    data,
    SCHEDULE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(11))),
    OAUTH_KV: {
      async put(key, value) { data.set(key, value); },
      async get(key, format) {
        const value = data.get(key);
        return format === 'json' && value ? JSON.parse(value) : value;
      },
      async delete(key) { data.delete(key); },
    },
  };
}

test('collector auth is provider-declared, not inferred from its identifier', () => {
  assert.doesNotThrow(() => assertAuthRequirement(AUTH.CWS));
  assert.doesNotThrow(() => assertAuthRequirement(AUTH.BRIGHT_DATA));
  assert.doesNotThrow(() => assertAuthRequirement(AUTH.PUBLIC));
  assert.throws(() => assertAuthRequirement({ kind: 'oauth', provider: 'google', scopes: [] }), /scopes/);
  assert.throws(() => assertAuthRequirement({ kind: 'none', provider: 'public', scopes: ['admin'] }), /Public/);
});

test('provider grants are encrypted, account/connection scoped, and scope restricted', async () => {
  const env = fakeEnv();
  const scopes = ['https://www.googleapis.com/auth/analytics.readonly'];
  await saveProviderGrant(env, { owner: 'alice', provider: 'google',
    connectionId: 'ga4-main', kind: 'oauth', token: 'private-ga4-refresh', scopes });
  const raw = [...env.data.values()][0];
  assert.doesNotMatch(raw, /private-ga4-refresh/);
  assert.equal(await readProviderGrant(env, { owner: 'alice', provider: 'google',
    connectionId: 'ga4-main', kind: 'oauth', scopes }), 'private-ga4-refresh');
  for (const options of [
    { owner: 'bob', provider: 'google', connectionId: 'ga4-main', kind: 'oauth', scopes },
    { owner: 'alice', provider: 'google', connectionId: 'cws-main', kind: 'oauth', scopes },
    { owner: 'alice', provider: 'google', connectionId: 'ga4-main', kind: 'oauth',
      scopes: ['https://www.googleapis.com/auth/chromewebstore.readonly'] },
  ]) await assert.rejects(readProviderGrant(env, options));
  await deleteProviderGrant(env, { owner: 'alice', provider: 'google', connectionId: 'ga4-main' });
  await assert.rejects(readProviderGrant(env, { owner: 'alice', provider: 'google',
    connectionId: 'ga4-main', kind: 'oauth', scopes }));
});

test('collector authorization resolves separate OAuth grants without CWS fallback', async () => {
  const env = fakeEnv(), scopes = ['https://www.googleapis.com/auth/analytics.readonly'];
  await saveProviderGrant(env, { owner: 'alice', provider: 'google', connectionId: 'ga4-main',
    kind: 'oauth', scopes, token: 'ga4-refresh' });
  assert.deepEqual(await resolveCollectorAuth({ env, googleSub: 'alice',
    requirement: { kind: 'oauth', provider: 'google', connection: 'ga4-main', scopes } }),
  { refreshToken: 'ga4-refresh' });
  await assert.rejects(resolveCollectorAuth({ env, googleSub: 'bob',
    requirement: { kind: 'oauth', provider: 'google', connection: 'ga4-main', scopes } }));
  assert.deepEqual(await resolveCollectorAuth({ env, googleSub: 'alice',
    requirement: AUTH.PUBLIC }), {});
});
