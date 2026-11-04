-- Private analytics and rankings are always scoped to the verified Google subject.
-- Apply to MCP_DB after the existing schema.sql has been initialized.
CREATE TABLE IF NOT EXISTS collector_subscriptions (
  google_sub TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collector_keywords (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en-US',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  PRIMARY KEY (google_sub, item_id, keyword, locale)
);

CREATE TABLE IF NOT EXISTS metric_history (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL,
  dimension_value TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  unique_user_count INTEGER,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id, date, metric, dimension, dimension_value)
);
CREATE INDEX IF NOT EXISTS idx_metric_history_lookup
  ON metric_history(google_sub, item_id, metric, dimension, date DESC);

CREATE TABLE IF NOT EXISTS ranking_history (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL,
  rank INTEGER,
  result_count INTEGER NOT NULL,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub, item_id, date, keyword, locale)
);
CREATE INDEX IF NOT EXISTS idx_ranking_history_lookup
  ON ranking_history(google_sub, item_id, keyword, date DESC);

CREATE TABLE IF NOT EXISTS collector_runs (
  run_id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  rows_written INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_scheduled_once
  ON collector_runs(google_sub, item_id, task_id, date)
  WHERE trigger_kind='scheduled';
CREATE INDEX IF NOT EXISTS idx_collector_runs_lookup
  ON collector_runs(google_sub, started_at DESC);
