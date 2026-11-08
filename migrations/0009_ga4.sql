-- GA4 belongs to a user-owned data source. Null means unreported, never inferred zero.
-- Date values are GA4 property reporting dates, not the CWS API's UTC dates.
CREATE TABLE IF NOT EXISTS ga4_daily_history (
  source_id TEXT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  active_users INTEGER,
  sessions INTEGER,
  page_views INTEGER,
  install_events INTEGER,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id,date)
);
CREATE TABLE IF NOT EXISTS ga4_channel_history (
  source_id TEXT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  source_medium TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  active_users INTEGER NOT NULL,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id,date,source_medium)
);
CREATE INDEX IF NOT EXISTS idx_ga4_channel_date ON ga4_channel_history(source_id,date DESC);
CREATE TABLE IF NOT EXISTS source_collector_runs (
  run_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  rows_written INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(source_id,collector_id,date_from,date_to,trigger_kind)
);
