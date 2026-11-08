-- OAuth transactions are separate from the user's MCP session.
-- Only a one-time state marker is stored in D1; verifier lives in short-lived KV.
CREATE TABLE IF NOT EXISTS source_oauth_states (
  state TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_source_oauth_states_expiry ON source_oauth_states(expires_at);
