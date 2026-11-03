-- High-write ingest state, kept out of the platform/auth database (PRD §7, §19.2).

-- Event de-duplication window (PRD §19.6): (product_env, event_id) for 24h.
CREATE TABLE event_dedup (
  product_env_id TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, event_id)
);
CREATE INDEX event_dedup_expiry ON event_dedup (expires_at);

-- Request-id lookup into partitioned R2 log archives (PRD §4.4 structured query).
CREATE TABLE log_index (
  product_env_id TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  occurred_at    INTEGER NOT NULL,
  level          TEXT NOT NULL,
  archive_key    TEXT NOT NULL
);
CREATE INDEX log_index_request ON log_index (product_env_id, request_id);
CREATE INDEX log_index_time ON log_index (product_env_id, occurred_at);
