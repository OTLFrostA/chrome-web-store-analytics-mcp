import { readCollectorCredential, readBrightDataKey } from './credentials.js';
import { assertAuthRequirement } from './auth-requirements.js';

// Transitional bridge: credentials remain in their current encrypted KV records.
// New providers must be explicitly registered; unknown providers fail closed.
const PROVIDERS = Object.freeze({
  'google:legacy-cws': async ({ env, googleSub, refreshToken }) => ({
    refreshToken: refreshToken || await readCollectorCredential(env, googleSub),
  }),
  'brightdata:user-key': async ({ env, googleSub }) => {
    const apiKey = await readBrightDataKey(env, googleSub);
    if (!apiKey) throw new Error('Bright Data authorization is missing.');
    return { apiKey };
  },
});

export async function resolveCollectorAuth({ requirement, env, googleSub, refreshToken }) {
  assertAuthRequirement(requirement);
  if (typeof googleSub !== 'string' || !googleSub) {
    throw new TypeError('An authenticated account is required.');
  }
  if (requirement.kind === 'none') return {};
  const resolver = PROVIDERS[requirement.provider + ':' + requirement.connection];
  if (!resolver) throw new Error('This data source requires a separately configured authorization.');
  const credentials = await resolver({ env, googleSub, refreshToken });
  if (requirement.kind === 'oauth' && !credentials.refreshToken) {
    throw new Error('OAuth authorization is missing.');
  }
  return credentials;
}
