-- Platform metadata (PRD §7 + v2.2 additions). Auth engine tables live in their own migration.
-- user_id columns reference the auth engine's user table; integrity is enforced in code to keep
-- the platform schema independent of the auth engine's table naming.
-- The single platform is a code constant (PRD §1.1), so there is no `platforms` table.

CREATE TABLE products (
  id              TEXT PRIMARY KEY,               -- product_id, immutable
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  visibility      TEXT NOT NULL DEFAULT 'open'   CHECK (visibility IN ('open','restricted')),
  redirect_uris   TEXT NOT NULL DEFAULT '[]',     -- JSON array
  allowed_origins TEXT NOT NULL DEFAULT '[]',     -- JSON array
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE product_environments (
  id                  TEXT PRIMARY KEY,           -- `{product_id}.{env}` = OIDC client_id = token aud
  product_id          TEXT NOT NULL REFERENCES products(id),
  env                 TEXT NOT NULL CHECK (env IN ('dev','staging','prod')),
  publishable_key     TEXT NOT NULL UNIQUE,
  user_key_salt       TEXT NOT NULL,              -- HMAC salt for analytics user_key (PRD §19.8)
  storage_quota_bytes INTEGER NOT NULL,
  max_object_bytes    INTEGER NOT NULL,
  allowed_mime_types  TEXT NOT NULL DEFAULT '[]', -- JSON array; empty = any
  unknown_event_policy TEXT NOT NULL DEFAULT 'accept' CHECK (unknown_event_policy IN ('accept','reject')),
  created_at          INTEGER NOT NULL,
  UNIQUE (product_id, env)
);

CREATE TABLE product_memberships (
  user_id      TEXT NOT NULL,
  product_id   TEXT NOT NULL REFERENCES products(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  joined_at    INTEGER NOT NULL,
  last_seen_at INTEGER,
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX product_memberships_product ON product_memberships (product_id, status);

CREATE TABLE service_credentials (
  id             TEXT PRIMARY KEY,
  product_env_id TEXT NOT NULL REFERENCES product_environments(id),
  label          TEXT,
  scopes         TEXT NOT NULL,                   -- JSON array of SERVICE_SCOPES
  secret_hash    TEXT NOT NULL UNIQUE,            -- SHA-256 hex; plaintext shown once
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  revoked_at     INTEGER
);

CREATE TABLE storage_buckets (
  id             TEXT PRIMARY KEY,
  product_env_id TEXT NOT NULL REFERENCES product_environments(id),
  name           TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  policy         TEXT NOT NULL DEFAULT '{}',      -- JSON
  created_at     INTEGER NOT NULL,
  UNIQUE (product_env_id, name)
);

CREATE TABLE storage_objects (
  id             TEXT PRIMARY KEY,
  product_env_id TEXT NOT NULL REFERENCES product_environments(id),
  bucket         TEXT NOT NULL,
  owner_user_id  TEXT,                            -- NULL for service-owned objects
  object_key     TEXT NOT NULL UNIQUE,            -- server-generated R2 key, never the filename
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','available','deleted')),
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  deleted_at     INTEGER,
  deleted_by     TEXT
);
CREATE INDEX storage_objects_owner ON storage_objects (product_env_id, bucket, owner_user_id, status);

CREATE TABLE event_schemas (
  id             TEXT PRIMARY KEY,
  product_env_id TEXT NOT NULL REFERENCES product_environments(id),
  event_name     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  json_schema    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (product_env_id, event_name, schema_version)
);

CREATE TABLE team_members (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','operator','product_admin','product_developer')),
  product_id TEXT REFERENCES products(id),        -- NULL for platform-wide roles
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((role IN ('owner','operator')) = (product_id IS NULL))
);
CREATE UNIQUE INDEX team_members_unique ON team_members (user_id, role, ifnull(product_id, ''));

-- Security / admin audit stream; not writable by product users (PRD §4.4).
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','service','system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  product_id  TEXT,
  env         TEXT,
  target_type TEXT,
  target_id   TEXT,
  request_id  TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  archive_ref TEXT
);
CREATE INDEX audit_log_product_time ON audit_log (product_id, occurred_at);
CREATE INDEX audit_log_actor_time ON audit_log (actor_id, occurred_at);

CREATE TABLE deletion_requests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('delete','export')),
  scope        TEXT NOT NULL CHECK (scope IN ('account','product')),
  product_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','cancelled','processing','completed','failed')),
  requested_at INTEGER NOT NULL,
  due_at       INTEGER NOT NULL,
  completed_at INTEGER,
  result_ref   TEXT
);
CREATE INDEX deletion_requests_due ON deletion_requests (status, due_at);

CREATE TABLE idempotency_keys (
  principal     TEXT NOT NULL,
  route         TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (principal, route, key)
);

-- Local / test email adapter only (PRD §19.10).
CREATE TABLE email_outbox (
  id         TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  template   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
