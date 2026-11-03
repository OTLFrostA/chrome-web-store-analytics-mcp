-- Separate database: do not apply this to the existing collector D1.
CREATE TABLE IF NOT EXISTS user_extensions (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  store_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_user_extensions_account ON user_extensions(google_sub);
