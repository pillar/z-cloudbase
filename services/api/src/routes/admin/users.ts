import {
  ApiError, BAN_MAX_DURATION_DAYS, BanUserRequest, IMPERSONATION_REQUEST_TTL_S, MEMBERSHIP_STATUSES, StartImpersonationRequest,
  USER_EXPORT_COLUMNS, USER_EXPORT_PAGE_ROWS, newId,
} from '@z-cloudbase/contracts';
import { can, visibleProducts } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { identity } from '../../identity.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadEnvId, loadProduct, parseEnv, readJson, readQuery, type C } from './util.ts';

export const userRoutes = new Hono<AppEnv>();

const LookupQuery = z
  .object({ user_id: z.string().startsWith('usr_').optional(), email: z.email().optional() })
  .refine((q) => (q.user_id === undefined) !== (q.email === undefined), 'Provide exactly one of user_id or email');

interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  isAnonymous: number | null;
  createdAt: string | number;
  deletedAt: string | number | null;
  banned: number | null;
  banReason: string | null;
  banExpires: string | null;
}

const USER_COLS = 'id, name, email, emailVerified, isAnonymous, createdAt, deletedAt, banned, banReason, banExpires';

/** Ban in effect: flagged and not past its optional end (PRD §21.5.1). */
const banActive = (u: { banned: number | null; banExpires: string | null }, now = Date.now()) =>
  Boolean(u.banned) && (!u.banExpires || Date.parse(u.banExpires) > now);

/**
 * Look up a global user by id or exact email. A platform-wide reader (owner) sees any user; a product
 * admin only sees users that are members of a product they may read, so lookup is not a global user oracle.
 */
userRoutes.get('/users', async (c) => {
  const q = readQuery(c, LookupQuery);
  const { grants } = c.get('admin');
  const platformWide = can(grants, 'users:read');
  const scoped = visibleProducts(grants);
  if (!platformWide && (scoped === 'all' || !scoped.some((p) => can(grants, 'users:read', { productId: p })))) {
    authorize(c, 'users:read'); // throws forbidden
  }

  const user = q.user_id
    ? await c.env.DB.prepare(`SELECT ${USER_COLS} FROM "user" WHERE id = ?`).bind(q.user_id).first<UserRow>()
    : await c.env.DB.prepare(`SELECT ${USER_COLS} FROM "user" WHERE lower(email) = ?`).bind(q.email!.toLowerCase()).first<UserRow>();
  if (!user) throw new ApiError('not_found', 'User not found');

  const memberships = (
    await c.env.DB.prepare(
      `SELECT m.product_id, p.name AS product_name, m.status, m.joined_at, m.last_seen_at
       FROM product_memberships m JOIN products p ON p.id = m.product_id WHERE m.user_id = ? ORDER BY m.joined_at`,
    ).bind(user.id).all<{ product_id: string }>()
  ).results.filter((m) => can(grants, 'users:read', { productId: m.product_id }));
  if (!platformWide && memberships.length === 0) throw new ApiError('not_found', 'User not found');

  const deletionRequests = (
    await c.env.DB.prepare(
      'SELECT id, kind, scope, product_id, status, requested_at, due_at, completed_at FROM deletion_requests WHERE user_id = ? ORDER BY requested_at DESC',
    ).bind(user.id).all<{ scope: string; product_id: string | null }>()
  ).results.filter((r) => (r.scope === 'account' ? platformWide : r.product_id !== null && can(grants, 'users:read', { productId: r.product_id })));

  await c.env.DB.batch([adminAudit(c, { action: 'user.lookup', targetType: 'user', targetId: user.id, metadata: { by: q.user_id ? 'user_id' : 'email' } })]);
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, email_verified: !!user.emailVerified, is_anonymous: !!user.isAnonymous, created_at: user.createdAt, deleted_at: user.deletedAt },
    // The ban reason is an internal note: only for callers who may ban.
    ban: {
      banned: banActive(user),
      expires_at: banActive(user) ? user.banExpires : null,
      ...(can(grants, 'users:ban') ? { reason: banActive(user) ? user.banReason : null } : {}),
    },
    memberships,
    deletion_requests: deletionRequests,
  });
});

const ListMembershipsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

userRoutes.get('/products/:id/memberships', async (c) => {
  const productId = c.req.param('id');
  authorize(c, 'users:read', { productId });
  const q = readQuery(c, ListMembershipsQuery);
  await loadProduct(c, productId);
  const { results } = await c.env.DB.prepare(
    'SELECT user_id, status, joined_at, last_seen_at FROM product_memberships WHERE product_id = ? ORDER BY joined_at, user_id LIMIT ? OFFSET ?',
  ).bind(productId, q.limit, q.offset).all();
  return c.json({ memberships: results });
});

const UpdateMembershipRequest = z.object({ status: z.enum(MEMBERSHIP_STATUSES) });

/** Suspend / reactivate / revoke. Access stops at once (withUser reads status per request); refresh tokens are revoked too. */
userRoutes.patch('/products/:id/memberships/:userId', async (c) => {
  const productId = c.req.param('id');
  const userId = c.req.param('userId');
  authorize(c, 'users:manage', { productId });
  const body = await readJson(c, UpdateMembershipRequest);
  const m = await c.env.DB.prepare('SELECT status FROM product_memberships WHERE user_id = ? AND product_id = ?')
    .bind(userId, productId).first<{ status: string }>();
  if (!m) throw new ApiError('not_found', 'Membership not found');
  // Revoked is terminal for admins (no revoked → suspended → active detour). A user who left
  // themselves can re-join an open product once the consumer has cleaned up the revoked row.
  if (m.status === 'revoked') {
    throw new ApiError('invalid_request', 'A revoked membership cannot be changed');
  }

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE product_memberships SET status = ? WHERE user_id = ? AND product_id = ?').bind(body.status, userId, productId),
    adminAudit(c, {
      action: 'membership.update', productId, targetType: 'membership', targetId: userId,
      metadata: { from: m.status, to: body.status },
    }),
  ]);
  // Status is already enforced above; a failure here surfaces as 503 and the call can simply be repeated.
  if (body.status !== 'active') {
    await identity(c.env).revokeUserTokens({ userId, productId, reason: `membership ${body.status} by admin` });
  }
  return c.json({ user_id: userId, product_id: productId, status: body.status });
});

// --- Platform user management (PRD §21.5): ban / unban, impersonation requests, per-environment export ---

/** A live (not deleted) user, or not_found. */
async function liveUser(c: C, userId: string): Promise<UserRow> {
  const user = await c.env.DB.prepare(`SELECT ${USER_COLS} FROM "user" WHERE id = ?`).bind(userId).first<UserRow>();
  if (!user || user.deletedAt) throw new ApiError('not_found', 'User not found');
  return user;
}

const isTeamMember = async (c: C, userId: string) =>
  Boolean(await c.env.DB.prepare('SELECT 1 AS x FROM team_members WHERE user_id = ? LIMIT 1').bind(userId).first());

/** Platform-wide ban (owner only). The identity worker writes the ban, audit and webhooks and revokes every session and token. */
userRoutes.post('/users/:userId/ban', async (c) => {
  authorize(c, 'users:ban');
  const body = await readJson(c, BanUserRequest);
  const user = await liveUser(c, c.req.param('userId'));
  if (await isTeamMember(c, user.id)) throw new ApiError('conflict', 'Platform team members cannot be banned; remove them from the team first');
  let expiresAt: string | null = null;
  if (body.expires_at) {
    const t = Date.parse(body.expires_at);
    if (t <= Date.now() || t > Date.now() + BAN_MAX_DURATION_DAYS * 24 * 3600 * 1000) {
      throw new ApiError('validation_failed', `expires_at must be in the future and at most ${BAN_MAX_DURATION_DAYS} days ahead`);
    }
    expiresAt = new Date(t).toISOString();
  }
  const result = await identity(c.env).setUserBan({
    userId: user.id, actorId: c.get('admin').userId, requestId: c.get('requestId'), ban: { reason: body.reason, expiresAt },
  });
  return c.json({ user_id: user.id, banned: result.banned, expires_at: result.expires_at, reason: result.reason ?? null });
});

userRoutes.delete('/users/:userId/ban', async (c) => {
  authorize(c, 'users:ban');
  const user = await liveUser(c, c.req.param('userId'));
  const result = await identity(c.env).setUserBan({ userId: user.id, actorId: c.get('admin').userId, requestId: c.get('requestId'), ban: null });
  return c.json({ user_id: user.id, banned: false, changed: result.changed });
});

/**
 * Request a support impersonation (owner with TOTP only). The owner confirms it on the identity domain
 * with a current TOTP code (`url`) within IMPERSONATION_REQUEST_TTL_S; a newer request replaces an
 * unconfirmed older one of the same owner.
 */
userRoutes.post('/users/:userId/impersonations', async (c) => {
  authorize(c, 'users:impersonate');
  const body = await readJson(c, StartImpersonationRequest);
  const actorId = c.get('admin').userId;
  const actor = await c.env.DB.prepare('SELECT twoFactorEnabled FROM "user" WHERE id = ?').bind(actorId).first<{ twoFactorEnabled: number | null }>();
  if (!actor?.twoFactorEnabled) {
    throw new ApiError('forbidden', 'Support sessions require two-factor authentication on your account', { reason: 'mfa_required' });
  }
  const user = await liveUser(c, c.req.param('userId'));
  if (user.id === actorId) throw new ApiError('conflict', 'You cannot impersonate yourself');
  if (await isTeamMember(c, user.id)) throw new ApiError('conflict', 'Platform team members cannot be impersonated');
  if (banActive(user)) throw new ApiError('conflict', 'Banned users cannot be impersonated');
  const id = newId('imp');
  const now = Date.now();
  const expiresAt = now + IMPERSONATION_REQUEST_TTL_S * 1000;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE impersonations SET status = 'cancelled', ended_at = ?, end_reason = 'superseded' WHERE actor_id = ? AND status = 'pending'`)
      .bind(now, actorId),
    c.env.DB.prepare(
      `INSERT INTO impersonations (id, actor_id, target_id, reason, status, created_at, request_expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(id, actorId, user.id, body.reason, now, expiresAt),
    adminAudit(c, { action: 'user.impersonation.request', targetType: 'user', targetId: user.id, metadata: { impersonation_id: id, reason: body.reason } }),
  ]);
  return c.json({ id, url: `${c.env.ISSUER}/impersonation/${id}`, expires_at: new Date(expiresAt).toISOString() }, 201);
});

const ExportQuery = z.object({
  include_email: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  after: z.string().startsWith('usr_').max(64).optional(),
});

function iso(v: number | string | null | undefined): string {
  if (v == null || v === '') return '';
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** CSV cell, quoted when needed; formula-looking values are neutralised with a leading quote (PRD §21.5.3). */
function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface ExportRow {
  user_id: string;
  isAnonymous: number | null;
  email: string;
  createdAt: string | number;
  first_seen_at: number;
  status: string | null;
  joined_at: number | null;
  last_seen_at: number | null;
  providers: string | null;
  banned: number;
}

/** The users of one product environment as CSV, USER_EXPORT_PAGE_ROWS per call (continue with `after` = X-Next-Cursor). */
userRoutes.get('/products/:id/environments/:env/users/export', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'users:read', { productId, env });
  const q = readQuery(c, ExportQuery);
  await loadProduct(c, productId);
  const productEnvId = await loadEnvId(c, productId, env);
  const { results } = await c.env.DB.prepare(
    `SELECT peu.user_id, u.isAnonymous, u.email, u.createdAt, peu.first_seen_at, m.status, m.joined_at, m.last_seen_at,
       (SELECT group_concat(p, ';') FROM (SELECT DISTINCT a.providerId AS p FROM account a WHERE a.userId = u.id ORDER BY 1)) AS providers,
       (u.banned = 1 AND (u.banExpires IS NULL OR u.banExpires > ?)) AS banned
     FROM product_env_users peu JOIN "user" u ON u.id = peu.user_id
     LEFT JOIN product_memberships m ON m.user_id = peu.user_id AND m.product_id = ?
     WHERE peu.product_env_id = ? AND u.deletedAt IS NULL AND peu.user_id > ?
     ORDER BY peu.user_id LIMIT ?`,
  ).bind(new Date().toISOString(), productId, productEnvId, q.after ?? '', USER_EXPORT_PAGE_ROWS + 1).all<ExportRow>();
  const more = results.length > USER_EXPORT_PAGE_ROWS;
  const rows = results.slice(0, USER_EXPORT_PAGE_ROWS);
  const header = [...USER_EXPORT_COLUMNS, ...(q.include_email ? ['email'] : [])];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells: unknown[] = [
      r.user_id, Boolean(r.isAnonymous), iso(r.createdAt), iso(r.first_seen_at), r.status ?? '', iso(r.joined_at), iso(r.last_seen_at),
      r.providers ?? '', Boolean(r.banned),
    ];
    if (q.include_email) cells.push(r.isAnonymous ? '' : r.email);
    lines.push(cells.map(csvCell).join(','));
  }
  await c.env.DB.batch([adminAudit(c, {
    action: 'user.export', productId, env, targetType: 'product_environment', targetId: productEnvId,
    metadata: { rows: rows.length, include_email: q.include_email, after: q.after ?? null, truncated: more },
  })]);
  if (more) c.header('X-Next-Cursor', rows[rows.length - 1]!.user_id);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${productId}-${env}-users.csv"`);
  c.header('Cache-Control', 'no-store');
  return c.body(`${lines.join('\r\n')}\r\n`);
});
