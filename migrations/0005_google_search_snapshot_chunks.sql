-- Store oversize Bright Data records in bounded UTF-8-safe string fragments.
-- The parent google_search_snapshots.payload_json carries a small completion marker
-- only after all fragments have been committed. Retry writes are idempotent.
CREATE TABLE IF NOT EXISTS google_search_snapshot_chunks (
  google_sub TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  keyword TEXT NOT NULL,
  market TEXT NOT NULL,
  device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  chunk_text TEXT NOT NULL,
  PRIMARY KEY (google_sub,item_id,date,keyword,market,device,snapshot_id,part_index),
  FOREIGN KEY (google_sub,item_id) REFERENCES user_extensions(google_sub,item_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_google_search_snapshot_chunks_lookup
  ON google_search_snapshot_chunks(google_sub,item_id,date,keyword,market,device,snapshot_id,part_index);
