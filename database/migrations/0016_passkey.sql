-- Passkeys (PRD §21.3): Better Auth 1.7.7 `@better-auth/passkey` plugin schema, written to match what the
-- Better Auth CLI (`auth@1.7.7 generate`) emits for SQLite (same style as 0011); do not change the
-- columns without changing the plugin config. Rows are deleted with the account (IdentityRpc.deleteUserIdentity).

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");
