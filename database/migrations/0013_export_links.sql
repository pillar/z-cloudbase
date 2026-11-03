-- One-time download links for completed data exports (PRD §19.8, §19.11). Only the SHA-256 of the
-- link token is stored; `used_at` is set by a single conditional UPDATE, so a link downloads once.

CREATE TABLE export_links (
  token_hash  TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES deletion_requests (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX export_links_user ON export_links (user_id, expires_at);
