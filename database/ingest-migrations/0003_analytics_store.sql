-- v3.1 analytics store (PRD §21.7–21.9). Timestamps are epoch milliseconds; `day` is the UTC day
-- number (occurred_at / 86400000). WITHOUT ROWID tables: the primary key is the table, so each insert
-- writes one row fewer than a rowid table with a separate key index (D1 bills index writes as rows).

-- One row per consumed event: explorer, consumer idempotency, and the local / test stand-in for
-- Analytics Engine (PRD §19.10). Replaces events_substitute.
CREATE TABLE event_rows (
  product_env_id TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  event_name     TEXT NOT NULL,
  user_key       TEXT,               -- HMAC(user_id, product salt); NULL for anonymous events
  anonymous_id   TEXT,
  session_id     TEXT,
  occurred_at    INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  source         TEXT NOT NULL DEFAULT '',
  browser        TEXT NOT NULL DEFAULT '',
  os             TEXT NOT NULL DEFAULT '',
  device         TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  path           TEXT NOT NULL DEFAULT '',
  dim1           TEXT NOT NULL DEFAULT '',
  dim2           TEXT NOT NULL DEFAULT '',
  dim3           TEXT NOT NULL DEFAULT '',
  dim_keys       TEXT NOT NULL DEFAULT '[]', -- declared keys at ingest time, for the explorer
  properties     TEXT,               -- JSON, NULL when larger than 1 KB (then properties_truncated = 1)
  properties_truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_env_id, event_id)
) WITHOUT ROWID;
CREATE INDEX event_rows_time ON event_rows (product_env_id, occurred_at);

INSERT INTO event_rows (product_env_id, event_id, event_name, user_key, anonymous_id, occurred_at, received_at)
  SELECT product_env_id, event_id, event_name, user_key, anonymous_id, occurred_at, received_at FROM events_substitute;
DROP TABLE events_substitute;

-- Per actor, day and event: first / last occurrence and count (funnels, event-based retention).
-- actor = user_key, or 'anon:' || anonymous_id. dims = JSON of the day's first occurrence dimensions.
CREATE TABLE actor_daily (
  product_env_id TEXT NOT NULL,
  event_name     TEXT NOT NULL,
  day            INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  first_at       INTEGER NOT NULL,
  last_at        INTEGER NOT NULL,
  n              INTEGER NOT NULL,
  dims           TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (product_env_id, event_name, day, actor)
) WITHOUT ROWID;
CREATE INDEX actor_daily_actor ON actor_daily (product_env_id, actor, day);

-- First / last day an actor was seen (first-seen retention cohorts).
CREATE TABLE actors (
  product_env_id TEXT NOT NULL,
  actor          TEXT NOT NULL,
  first_day      INTEGER NOT NULL,
  last_day       INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, actor)
) WITHOUT ROWID;

-- Product-scoped user properties (PRD §21.7), keyed by user_key, never by raw user_id.
CREATE TABLE user_properties (
  product_env_id TEXT NOT NULL,
  user_key       TEXT NOT NULL,
  properties     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, user_key)
) WITHOUT ROWID;

-- Per product environment analytics settings (PRD §21.8): declared custom dimension keys.
CREATE TABLE analytics_settings (
  product_env_id TEXT PRIMARY KEY,
  dimensions     TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);

-- user_keys of deleted users / left products: excluded from every archive export until the archive
-- partitions that may hold them have expired (PRD §21.9).
CREATE TABLE archive_suppressions (
  product_env_id TEXT NOT NULL,
  user_key       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, user_key)
) WITHOUT ROWID;
