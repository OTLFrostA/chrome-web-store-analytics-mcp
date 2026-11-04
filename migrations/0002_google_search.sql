-- Google organic search / SerpAPI (user-owned API key, encrypted in KV).
-- No plaintext API keys or shared product-specific keywords are stored in D1.
CREATE TABLE IF NOT EXISTS google_search_settings (
  google_sub TEXT PRIMARY KEY,
  monthly_limit INTEGER NOT NULL DEFAULT 200 CHECK (monthly_limit BETWEEN 1 AND 100000),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_search_keywords (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  keyword TEXT NOT NULL COLLATE NOCASE,
  market TEXT NOT NULL DEFAULT 'us/en',
  device TEXT NOT NULL DEFAULT 'desktop',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (google_sub,item_id,keyword,market,device)
);
CREATE INDEX IF NOT EXISTS idx_google_search_keywords_scope
  ON google_search_keywords(google_sub,item_id,enabled);

CREATE TABLE IF NOT EXISTS google_search_history (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  keyword TEXT NOT NULL COLLATE NOCASE,
  market TEXT NOT NULL,
  device TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','found','not_found','error')),
  rank INTEGER,
  result_url TEXT,
  result_title TEXT,
  result_count INTEGER,
  error_code TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub,item_id,date,keyword,market,device)
);
CREATE INDEX IF NOT EXISTS idx_google_search_history_lookup
  ON google_search_history(google_sub,item_id,date DESC);
CREATE INDEX IF NOT EXISTS idx_google_search_history_budget
  ON google_search_history(google_sub,date);
