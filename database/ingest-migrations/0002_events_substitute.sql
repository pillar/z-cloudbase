-- Local / test substitute for Analytics Engine (PRD §19.10): consumed events, read by the D1 AnalyticsQuery.
-- The primary key doubles as the consumer-side idempotency guard (a redelivered message inserts nothing).
-- Pruned by cron after ANALYTICS_QUERY_WINDOW_DAYS. Timestamps are epoch milliseconds.
CREATE TABLE events_substitute (
  product_env_id TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  event_name     TEXT NOT NULL,
  user_key       TEXT,                -- HMAC(user_id, product salt); NULL for anonymous events
  anonymous_id   TEXT,
  occurred_at    INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, event_id)
);
CREATE INDEX events_substitute_time ON events_substitute (product_env_id, occurred_at);
