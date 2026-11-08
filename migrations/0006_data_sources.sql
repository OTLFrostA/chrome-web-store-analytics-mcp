-- A data source is a user-owned external resource, not a collector or OAuth session.
-- Existing user_extensions and history remain untouched during the compatibility period.
CREATE TABLE IF NOT EXISTS data_sources (
  source_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('cws','ga4','brightdata','public')),
  provider TEXT NOT NULL,
  external_resource_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  auth_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK(auth_status IN ('disconnected','pending','connected','reauthorization_required')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_user_id,source_type,external_resource_id)
);
CREATE INDEX IF NOT EXISTS idx_data_sources_owner
  ON data_sources(owner_user_id,source_type,enabled);

-- A collector configuration references a source. Credentials never live in this table.
CREATE TABLE IF NOT EXISTS data_source_collectors (
  source_id TEXT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_id,collector_id)
);

-- Nonsecret grant metadata; encrypted tokens remain in KV, bound to owner/source.
CREATE TABLE IF NOT EXISTS data_source_authorizations (
  source_id TEXT PRIMARY KEY REFERENCES data_sources(source_id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK(auth_kind IN ('oauth','api-key')),
  provider_account_id TEXT,
  granted_scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('connected','reauthorization_required')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
