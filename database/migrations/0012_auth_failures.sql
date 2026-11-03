-- Turnstile trigger (PRD §19.6, §19.11): failed authentication attempts per account and per client IP.
-- `subject` is `acct:` / `ip:` + HMAC-SHA256(AUTH_SECRET, email | ip) in hex — never the raw value.
-- Rows older than AUTH_FAILURE_WINDOW_S are ignored and pruned when the subject fails again.

CREATE TABLE auth_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX auth_failures_subject ON auth_failures (subject, occurred_at);
