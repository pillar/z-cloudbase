-- Platform invitations (PRD §21.2): with SIGNUP_MODE=invite only an invitation link lets a new account
-- register. Only the SHA-256 of the link token is stored; `used_at` is set by a single conditional UPDATE,
-- so a link registers one account. Status (pending / used / revoked / expired) is derived from the columns.

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  delivery    TEXT NOT NULL CHECK (delivery IN ('email', 'link')),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by     TEXT,
  revoked_at  INTEGER,
  revoked_by  TEXT
);
CREATE INDEX invitations_email ON invitations (email, expires_at);
CREATE INDEX invitations_created ON invitations (created_at);
