-- Official Chrome Web Store reviews; scoped by the authenticated Google account and linked item.
-- Review names are stable identifiers; saving a repeat never creates a duplicate.
CREATE TABLE IF NOT EXISTS review_collection_settings (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  max_pages INTEGER NOT NULL DEFAULT 5 CHECK(max_pages BETWEEN 1 AND 10),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub,item_id)
);

CREATE TABLE IF NOT EXISTS review_history (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  review_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (google_sub,item_id,review_name)
);
CREATE INDEX IF NOT EXISTS idx_review_history_latest
  ON review_history(google_sub,item_id,create_time DESC);
CREATE INDEX IF NOT EXISTS idx_review_history_first_seen
  ON review_history(google_sub,item_id,first_seen_at DESC);
