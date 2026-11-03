-- identity: platform user management (PRD §21.5). Ban state on the engine's user table and the
-- impersonation marker on sessions: the same column names and types as Better Auth 1.7.7's admin plugin
-- (`banned`, `banReason`, `banExpires`, `session.impersonatedBy`), declared as the schema of the platform's
-- own plugin (services/identity/src/user-admin.ts) instead of adopting the admin plugin (PRD §21.5).

alter table "user" add column "banned" integer default 0;

alter table "user" add column "banReason" text;

alter table "user" add column "banExpires" date;

alter table "session" add column "impersonatedBy" text;

-- Support impersonations (PRD §21.5.2): requested in the console (pending), confirmed with a TOTP code on
-- the identity domain (active, bound to the impersonation session), then ended / cancelled.
CREATE TABLE impersonations (
  id                 TEXT PRIMARY KEY,                -- imp_<uuidv7>
  actor_id           TEXT NOT NULL,                   -- the owner
  target_id          TEXT NOT NULL,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','active','ended','cancelled')),
  created_at         INTEGER NOT NULL,
  request_expires_at INTEGER NOT NULL,
  session_id         TEXT,                            -- engine session id while active
  started_at         INTEGER,
  expires_at         INTEGER,
  ended_at           INTEGER,
  end_reason         TEXT
);
CREATE INDEX impersonations_actor ON impersonations (actor_id, status);
CREATE INDEX impersonations_target ON impersonations (target_id, status);
CREATE INDEX impersonations_session ON impersonations (session_id);
CREATE INDEX impersonations_expiry ON impersonations (status, expires_at);

-- Product tokens issued during an impersonation die with its session, whatever deletes the session (stop,
-- sign-out, expiry clean-up, revoke-all, ban). Without this, the engine's `ON DELETE SET NULL` would keep
-- the refresh tokens alive without the session that marks them as impersonated.
CREATE TRIGGER session_impersonation_tokens BEFORE DELETE ON "session"
FOR EACH ROW WHEN OLD."impersonatedBy" IS NOT NULL
BEGIN
  DELETE FROM "oauthAccessToken" WHERE "sessionId" = OLD."id";
  DELETE FROM "oauthRefreshToken" WHERE "sessionId" = OLD."id";
END;
