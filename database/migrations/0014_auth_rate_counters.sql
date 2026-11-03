-- Auth rate limits (PRD §19.6): fixed one-minute windows per client IP and per account.
-- `key` is `ip:` / `acct:` + HMAC-SHA256(AUTH_SECRET, ip | email) in hex — never the raw value.
-- Replaces the Cloudflare Rate Limiting binding, which counts per machine and let 54 of 55 attempts
-- through on staging (2026-10-09). Windows older than two minutes are pruned by the consumer cron.

CREATE TABLE auth_rate_counters (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;
CREATE INDEX auth_rate_counters_window ON auth_rate_counters (window_start);
