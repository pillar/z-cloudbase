// Platform invitations (PRD §21.2). Only the SHA-256 of a link token is stored; a link is claimed by one
// conditional UPDATE (single use) and released again if the registration it was claimed for fails.
// With mail available the link only goes out by mail, so redeeming it proves the mailbox; without mail
// it is returned once to the admin and redeeming it proves nothing about the address.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ApiError,
  INVITATION_TTL_DAYS_DEFAULT,
  newId,
  type CreatedInvitation,
  type Invitation,
  type InvitationDelivery,
  type InvitationStatus,
} from '@z-cloudbase/contracts';
import { sha256Hex } from '@z-cloudbase/security';
import { writeAudit } from './audit.ts';
import { emailAdapterFor, mailAvailable } from './email.ts';
import { requestLang } from './i18n.ts';
import { requireEmailVerification, type Lang } from './settings.ts';

const DAY_MS = 24 * 3600 * 1000;

interface Row {
  id: string;
  email: string;
  delivery: InvitationDelivery;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  revoked_at: number | null;
}

const COLS = 'id, email, delivery, created_by, created_at, expires_at, used_at, used_by, revoked_at';
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

function status(r: Row, now = Date.now()): InvitationStatus {
  if (r.used_at) return 'used';
  if (r.revoked_at) return 'revoked';
  return r.expires_at <= now ? 'expired' : 'pending';
}

const toInvitation = (r: Row): Invitation => ({
  id: r.id, email: r.email, status: status(r), delivery: r.delivery, created_by: r.created_by,
  created_at: iso(r.created_at)!, expires_at: iso(r.expires_at)!, used_at: iso(r.used_at), used_by: r.used_by, revoked_at: iso(r.revoked_at),
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenHash = (token: string) => sha256Hex(`invitation:${token}`);
export const invitationUrl = (issuer: string, token: string) => `${issuer}/register?${new URLSearchParams({ invite: token })}`;

/** Status condition of a still-usable invitation (pending and not expired). */
const PENDING = 'used_at IS NULL AND revoked_at IS NULL AND expires_at > ?';

export async function createInvitation(
  env: Env,
  input: { email: string; expiresInDays?: number; lang?: Lang; actorId: string; requestId?: string },
): Promise<CreatedInvitation> {
  const db = env.DB;
  const email = input.email.trim().toLowerCase();
  const delivery: InvitationDelivery = mailAvailable(env) ? 'email' : 'link';
  if (delivery === 'link' && requireEmailVerification(env)) {
    throw new ApiError(
      'invalid_request',
      'No mail transport is configured and email verification is required: an invited user could never verify the address. Configure mail or set REQUIRE_EMAIL_VERIFICATION=false',
    );
  }
  if (await db.prepare('SELECT 1 FROM "user" WHERE lower(email) = ?').bind(email).first()) {
    throw new ApiError('conflict', 'An account with this email already exists');
  }
  const now = Date.now();
  if (await db.prepare(`SELECT 1 FROM invitations WHERE email = ? AND ${PENDING}`).bind(email, now).first()) {
    throw new ApiError('conflict', 'A pending invitation for this email exists; revoke it first');
  }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const days = input.expiresInDays ?? INVITATION_TTL_DAYS_DEFAULT;
  const row: Row = {
    id: newId('inv'), email, delivery, created_by: input.actorId, created_at: now, expires_at: now + days * DAY_MS,
    used_at: null, used_by: null, revoked_at: null,
  };
  await db
    .prepare('INSERT INTO invitations (id, email, token_hash, delivery, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, email, await tokenHash(token), delivery, row.created_by, row.created_at, row.expires_at)
    .run();
  const url = invitationUrl(env.ISSUER, token);
  if (delivery === 'email') {
    try {
      await emailAdapterFor(env).send({ to: email, template: 'invitation', payload: { url, days: String(days) }, lang: requestLang(env, input.lang) });
    } catch (e) {
      // Nobody got the link: the invitation must not stay pending.
      await db.prepare('DELETE FROM invitations WHERE id = ?').bind(row.id).run();
      console.error('invitation mail failed', (e as Error).message);
      throw new ApiError('unavailable', 'The invitation email could not be sent, try again later');
    }
  }
  await writeAudit(db, {
    actorType: 'user', actorId: input.actorId, action: 'invitation.create', targetType: 'invitation', targetId: row.id,
    requestId: input.requestId ?? null, metadata: { delivery, expires_in_days: days },
  });
  return { ...toInvitation(row), ...(delivery === 'link' ? { url } : {}) };
}

export async function listInvitations(db: D1Database, q: { status?: InvitationStatus; limit: number; offset: number }) {
  const now = Date.now();
  const where = {
    pending: `WHERE ${PENDING}`,
    used: 'WHERE used_at IS NOT NULL',
    revoked: 'WHERE used_at IS NULL AND revoked_at IS NOT NULL',
    expired: 'WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?',
  }[q.status ?? 'pending'];
  const filter = q.status ? where : '';
  const binds = q.status === 'pending' || q.status === 'expired' ? [now] : [];
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM invitations ${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, q.limit, q.offset)
    .all<Row>();
  return { invitations: results.map(toInvitation) };
}

export async function revokeInvitation(db: D1Database, input: { id: string; actorId: string; requestId?: string }): Promise<Invitation> {
  const now = Date.now();
  const updated = await db
    .prepare(`UPDATE invitations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND ${PENDING} RETURNING ${COLS}`)
    .bind(now, input.actorId, input.id, now)
    .first<Row>();
  if (!updated) {
    const row = await db.prepare(`SELECT ${COLS} FROM invitations WHERE id = ?`).bind(input.id).first<Row>();
    if (!row) throw new ApiError('not_found', 'Invitation not found');
    throw new ApiError('conflict', `Invitation is ${status(row, now)}`);
  }
  await writeAudit(db, {
    actorType: 'user', actorId: input.actorId, action: 'invitation.revoke', targetType: 'invitation', targetId: input.id,
    requestId: input.requestId ?? null, metadata: {},
  });
  return toInvitation(updated);
}

/** A usable invitation for a link token (for the registration page), without claiming it. */
export async function findPendingInvitation(db: D1Database, token: string): Promise<{ id: string; email: string } | null> {
  if (!token || token.length > 128) return null;
  return db
    .prepare(`SELECT id, email FROM invitations WHERE token_hash = ? AND ${PENDING}`)
    .bind(await tokenHash(token), Date.now())
    .first<{ id: string; email: string }>();
}

/** The invitation a registration is running under (read by the signup policy, src/signup-policy.ts). */
export interface Redemption {
  id: string;
  email: string;
  /** Delivered by mail: redeeming the link proves the mailbox. */
  verified: boolean;
}
export const redemption = new AsyncLocalStorage<Redemption>();

/** Single use: claims the invitation atomically; `release` undoes the claim if the registration fails. */
export async function claimInvitation(db: D1Database, token: string): Promise<Redemption | null> {
  if (!token || token.length > 128) return null;
  const row = await db
    .prepare(`UPDATE invitations SET used_at = ? WHERE token_hash = ? AND ${PENDING} RETURNING id, email, delivery`)
    .bind(Date.now(), await tokenHash(token), Date.now())
    .first<{ id: string; email: string; delivery: InvitationDelivery }>();
  return row ? { id: row.id, email: row.email, verified: row.delivery === 'email' } : null;
}

export async function releaseInvitation(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE invitations SET used_at = NULL WHERE id = ? AND used_by IS NULL').bind(id).run();
}

export async function completeInvitation(db: D1Database, id: string, userId: string, requestId?: string): Promise<void> {
  await db.prepare('UPDATE invitations SET used_by = ? WHERE id = ?').bind(userId, id).run();
  await writeAudit(db, {
    actorType: 'user', actorId: userId, action: 'auth.invitation_redeemed', targetType: 'invitation', targetId: id,
    requestId: requestId ?? null, metadata: {},
  });
}
