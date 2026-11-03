// Account-level self-service on the identity domain (PRD §19.8): request / cancel global account
// deletion, request a data export and download it through a one-time link. These act across every
// product of the user, so they are NOT offered by product APIs: a product access token proves
// neither a recent sign-in nor a right to cross-product data. Here the identity session cookie is
// required, and the sensitive steps also need a sign-in within the re-authentication window (PRD §19.4).
import {
  ACCOUNT_DELETION_COOLDOWN_DAYS,
  ApiError,
  EXPORT_LINK_TTL_S,
  REAUTH_WINDOW_S,
  newId,
  type SelfServiceRequest,
} from '@z-cloudbase/contracts';
import { sha256Hex, type RequestIdVars } from '@z-cloudbase/security';
import { Hono, type Context } from 'hono';
import { isFreshSession } from './account-policy.ts';
import { writeAudit } from './audit.ts';
import { getAuth } from './instance.ts';

type AccountEnv = { Bindings: Env; Variables: RequestIdVars };
type C = Context<AccountEnv>;

const DAY_MS = 24 * 3600 * 1000;

interface RequestRow {
  id: string;
  kind: 'delete' | 'export';
  scope: 'account' | 'product';
  status: SelfServiceRequest['status'];
  requested_at: number;
  due_at: number;
  completed_at: number | null;
}

const COLUMNS = 'id, kind, scope, status, requested_at, due_at, completed_at';
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** result_ref (the internal archive path) is never exposed. */
export const toRequest = (r: RequestRow): SelfServiceRequest => ({
  id: r.id, kind: r.kind, scope: r.scope, status: r.status,
  requested_at: iso(r.requested_at)!, due_at: iso(r.due_at)!, completed_at: iso(r.completed_at),
});

/** Form posts from the account page get a redirect; API callers get JSON. */
export const isForm = (c: C) => (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded');

/** The signed-in user; with `fresh`, the session must come from a sign-in within REAUTH_WINDOW_S. */
export async function requireUser(c: C, opts: { fresh: boolean }) {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError('unauthenticated', 'Sign in first');
  // An anonymous user has no credential to re-authenticate with (same rule as account-policy.ts).
  const anonymous = Boolean((session.user as { isAnonymous?: boolean | null }).isAnonymous);
  if (opts.fresh && !anonymous && !isFreshSession(session.session.createdAt)) {
    throw new ApiError('forbidden', `Sign in again: this action requires a sign-in within the last ${REAUTH_WINDOW_S / 60} minutes`, {
      reason: 'reauth_required',
    });
  }
  return session.user;
}

/** All account-scoped requests of the user, newest first. */
export async function listAccountRequests(db: D1Database, userId: string): Promise<SelfServiceRequest[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM deletion_requests WHERE user_id = ? AND scope = 'account' ORDER BY requested_at DESC, id DESC LIMIT 50`)
    .bind(userId)
    .all<RequestRow>();
  return results.map(toRequest);
}

/** Insert an account-level request; a still-open one of the same kind is returned instead (idempotent). */
async function openRequest(c: C, userId: string, kind: 'delete' | 'export', dueAt: number, action: string) {
  const db = c.env.DB;
  const id = newId('del');
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO deletion_requests (id, user_id, kind, scope, status, requested_at, due_at) VALUES (?, ?, ?, 'account', 'pending', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, userId, kind, now, dueAt)
    .run();
  const created = inserted.meta.changes > 0;
  if (created) {
    await writeAudit(db, { actorType: 'user', actorId: userId, action, targetType: 'deletion_request', targetId: id, requestId: c.get('requestId') });
  }
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM deletion_requests WHERE user_id = ? AND kind = ? AND scope = 'account' AND status IN ('pending','processing')`)
    .bind(userId, kind)
    .first<RequestRow>();
  if (!row) throw new ApiError('internal', 'Request could not be recorded');
  if (isForm(c)) return c.redirect('/account', 303);
  return c.json(toRequest(row), created ? 202 : 200);
}

export const account = new Hono<AccountEnv>();

account.get('/account/requests', async (c) => {
  const user = await requireUser(c, { fresh: false });
  return c.json({ requests: await listAccountRequests(c.env.DB, user.id) });
});

// Global account deletion: due after the cooldown (PRD §19.8), processed by the consumer cron.
account.post('/account/deletion', async (c) => {
  const user = await requireUser(c, { fresh: true });
  return openRequest(c, user.id, 'delete', Date.now() + ACCOUNT_DELETION_COOLDOWN_DAYS * DAY_MS, 'account.deletion.request');
});

/** Cancel during the cooldown; once the consumer picked it up it can no longer be cancelled. */
async function cancelDeletion(c: C) {
  const user = await requireUser(c, { fresh: false });
  const db = c.env.DB;
  const row = await db
    .prepare(`SELECT id FROM deletion_requests WHERE user_id = ? AND kind = 'delete' AND scope = 'account' AND status = 'pending'`)
    .bind(user.id)
    .first<{ id: string }>();
  if (!row) throw new ApiError('not_found', 'No pending account deletion');
  const upd = await db.prepare(`UPDATE deletion_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).bind(row.id).run();
  if (upd.meta.changes === 0) throw new ApiError('not_found', 'No pending account deletion');
  await writeAudit(db, {
    actorType: 'user', actorId: user.id, action: 'account.deletion.cancel', targetType: 'deletion_request', targetId: row.id,
    requestId: c.get('requestId'),
  });
  return isForm(c) ? c.redirect('/account', 303) : c.body(null, 204);
}

account.delete('/account/deletion', cancelDeletion);
// HTML forms cannot send DELETE.
account.post('/account/deletion/cancel', cancelDeletion);

// Export of identity, memberships and storage object list (PRD §19.8), built by the consumer cron.
account.post('/account/export', async (c) => {
  const user = await requireUser(c, { fresh: true });
  return openRequest(c, user.id, 'export', Date.now(), 'account.export.request');
});

const linkToken = () => {
  let bin = '';
  for (const b of crypto.getRandomValues(new Uint8Array(32))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * One-time download link for a completed export of the signed-in user (PRD §19.8, §19.11): needs a
 * recent sign-in; valid EXPORT_LINK_TTL_S; only the token's SHA-256 is stored. The account page's
 * form is sent straight on to the link (a download); API callers get the URL.
 */
account.post('/account/exports/:id/link', async (c) => {
  let user;
  try {
    user = await requireUser(c, { fresh: true });
  } catch (e) {
    // The account page's Download button with a stale sign-in: sign in again instead of a JSON error.
    if (isForm(c) && e instanceof ApiError && (e.code === 'unauthenticated' || e.code === 'forbidden')) return c.redirect('/login', 303);
    throw e;
  }
  const db = c.env.DB;
  const id = c.req.param('id');
  const row = await db
    .prepare(`SELECT id FROM deletion_requests WHERE id = ? AND user_id = ? AND kind = 'export' AND scope = 'account' AND status = 'completed'`)
    .bind(id, user.id)
    .first<{ id: string }>();
  // Someone else's request and an unfinished one look the same.
  if (!row) throw new ApiError('not_found', 'Export not found');
  const token = linkToken();
  const now = Date.now();
  const expiresAt = now + EXPORT_LINK_TTL_S * 1000;
  await db.batch([
    db.prepare('DELETE FROM export_links WHERE user_id = ? AND expires_at <= ?').bind(user.id, now),
    db.prepare('INSERT INTO export_links (token_hash, request_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), id, user.id, now, expiresAt),
  ]);
  await writeAudit(db, {
    actorType: 'user', actorId: user.id, action: 'account.export.link_create', targetType: 'deletion_request', targetId: id,
    requestId: c.get('requestId'), metadata: { expires_at: iso(expiresAt) },
  });
  const path = `/account/export-links/${token}`;
  c.header('cache-control', 'no-store');
  if (isForm(c)) return c.redirect(path, 303);
  return c.json({ url: `${c.env.ISSUER}${path}`, expires_at: iso(expiresAt) }, 201);
});

/**
 * Download through a one-time link, for the user who created it only. The link is consumed by a
 * single conditional UPDATE (unused, unexpired, same user), so concurrent requests download once.
 * Used, expired, unknown and other users' links all answer 404.
 */
account.get('/account/export-links/:token', async (c) => {
  // Opened in the browser (a navigation): no session goes to the login page instead of a JSON error.
  const navigation = c.req.header('sec-fetch-mode') === 'navigate' || (c.req.header('accept') ?? '').includes('text/html');
  let user;
  try {
    user = await requireUser(c, { fresh: false });
  } catch (e) {
    if (navigation && e instanceof ApiError && e.code === 'unauthenticated') return c.redirect('/login', 302);
    throw e;
  }
  const now = Date.now();
  const link = await c.env.DB
    .prepare(
      `UPDATE export_links SET used_at = ? WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING request_id`,
    )
    .bind(now, await sha256Hex(c.req.param('token')), user.id, now)
    .first<{ request_id: string }>();
  const row = link
    ? await c.env.DB.prepare(`SELECT result_ref FROM deletion_requests WHERE id = ? AND user_id = ? AND status = 'completed'`)
      .bind(link.request_id, user.id)
      .first<{ result_ref: string | null }>()
    : null;
  const obj = row?.result_ref ? await c.env.ARCHIVE.get(row.result_ref) : null;
  if (!link || !obj) throw new ApiError('not_found', 'This download link is invalid, expired or already used');
  await writeAudit(c.env.DB, {
    actorType: 'user', actorId: user.id, action: 'account.export.download', targetType: 'deletion_request', targetId: link.request_id,
    requestId: c.get('requestId'),
  });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="z-cloudbase-export-${link.request_id}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
