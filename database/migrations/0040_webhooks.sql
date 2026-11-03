-- admin: product webhooks (PRD §21.6). Endpoints per product environment, an outbox of messages
-- (one per event and product environment; its id is the `webhook-id`), one delivery per subscribed
-- endpoint, and the per-attempt delivery log.

CREATE TABLE webhook_endpoints (
  id                         TEXT PRIMARY KEY,         -- whe_<uuidv7>
  product_env_id             TEXT NOT NULL REFERENCES product_environments(id),
  url                        TEXT NOT NULL,
  description                TEXT,
  event_types                TEXT NOT NULL,            -- JSON array of WEBHOOK_EVENT_TYPES
  enabled                    INTEGER NOT NULL DEFAULT 1,
  secret                     TEXT NOT NULL,            -- whsec_…; needed in clear text to sign
  previous_secret            TEXT,                     -- still signs until previous_secret_expires_at
  previous_secret_expires_at INTEGER,
  created_by                 TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_env ON webhook_endpoints (product_env_id);

CREATE TABLE webhook_messages (
  id             TEXT PRIMARY KEY,                     -- msg_<uuidv7> = webhook-id
  product_env_id TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        TEXT NOT NULL,                        -- the exact JSON body that is signed
  created_at     INTEGER NOT NULL
);
CREATE INDEX webhook_messages_created ON webhook_messages (created_at);

CREATE TABLE webhook_deliveries (
  message_id      TEXT NOT NULL REFERENCES webhook_messages(id) ON DELETE CASCADE,
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,                    -- also the claim lease while an attempt runs
  last_attempt_at INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, endpoint_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, status);

CREATE TABLE webhook_attempts (
  id               TEXT PRIMARY KEY,                   -- wha_<uuidv7>
  endpoint_id      TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  attempted_at     INTEGER NOT NULL,
  status_code      INTEGER,
  latency_ms       INTEGER NOT NULL,
  error            TEXT,
  response_snippet TEXT                                -- first WEBHOOK_RESPONSE_SNIPPET_MAX characters
);
CREATE INDEX webhook_attempts_endpoint ON webhook_attempts (endpoint_id, attempted_at);
