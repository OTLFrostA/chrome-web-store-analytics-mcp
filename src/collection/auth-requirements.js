// Data-source authorization is deliberately distinct from MCP client authorization.
// A collector declares a credential capability; the runner never infers it from its ID.
export const AUTH = Object.freeze({
  CWS: Object.freeze({
    kind: 'oauth', provider: 'google', connection: 'legacy-cws',
    scopes: Object.freeze(['https://www.googleapis.com/auth/chromewebstore.readonly']),
  }),
  BRIGHT_DATA: Object.freeze({
    kind: 'api-key', provider: 'brightdata', connection: 'user-key',
    scopes: Object.freeze([]),
  }),
  PUBLIC: Object.freeze({ kind: 'none', provider: 'public', scopes: Object.freeze([]) }),
});

// Provider scopes are not MCP resource scopes (e.g. cws:read).
// A valid MCP login never implies any authorization to a downstream API.
export function assertAuthRequirement(requirement) {
  if (!requirement || !['oauth', 'api-key', 'none'].includes(requirement.kind) ||
    typeof requirement.provider !== 'string' || !requirement.provider ||
    !Array.isArray(requirement.scopes) || requirement.scopes.some(scope =>
      typeof scope !== 'string' || !scope)) {
    throw new TypeError('Invalid collector authorization requirement.');
  }
  if (requirement.kind === 'oauth' && !requirement.scopes.length) {
    throw new TypeError('OAuth collectors must declare required provider scopes.');
  }
  if (requirement.kind === 'none' && requirement.scopes.length) {
    throw new TypeError('Public collectors must not request scopes.');
  }
}
