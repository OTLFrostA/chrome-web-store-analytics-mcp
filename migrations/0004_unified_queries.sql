-- Account-scoped historical data from external queries.
-- Query services persist before returning results. Existing history is retained.

CREATE TABLE IF NOT EXISTS rating_history (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id, date)
);
CREATE INDEX IF NOT EXISTS idx_rating_history_lookup
  ON rating_history(google_sub, item_id, date DESC);

CREATE TABLE IF NOT EXISTS extension_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status_json TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_extension_status_events_lookup
  ON extension_status_events(google_sub, item_id, id DESC);

-- Preserve the full, normalized search results, not just this extension's rank.
CREATE TABLE IF NOT EXISTS webstore_search_snapshots (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL,
  results_json TEXT NOT NULL,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id, date, keyword, locale)
);

-- Each Bright Data record (including its organic results) is stored before a
-- snapshot is acknowledged as processed. No API keys or OAuth tokens are stored.
CREATE TABLE IF NOT EXISTS google_search_snapshots (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  market TEXT NOT NULL,
  device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id, date, keyword, market, device)
);
CREATE INDEX IF NOT EXISTS idx_google_search_snapshots_lookup
  ON google_search_snapshots(google_sub, item_id, date DESC);
