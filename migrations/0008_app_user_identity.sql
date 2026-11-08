-- Stable application user IDs are independent from MCP login and upstream provider identities.
-- Existing CWS records remain keyed by their legacy Google subject during migration.
CREATE TABLE IF NOT EXISTS app_users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_user_identities (
  identity_provider TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(identity_provider,identity_subject)
);
CREATE INDEX IF NOT EXISTS idx_app_user_identities_user ON app_user_identities(user_id);
