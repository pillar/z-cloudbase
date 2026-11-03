import { ApiError, MEMBERSHIP_STATUSES } from '@z-cloudbase/contracts';
import { can, visibleProducts } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { identity } from '../../identity.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadProduct, readJson, readQuery } from './util.ts';

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
}

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
    ? await c.env.DB.prepare('SELECT id, name, email, emailVerified, isAnonymous, createdAt, deletedAt FROM "user" WHERE id = ?').bind(q.user_id).first<UserRow>()
    : await c.env.DB.prepare('SELECT id, name, email, emailVerified, isAnonymous, createdAt, deletedAt FROM "user" WHERE lower(email) = ?').bind(q.email!.toLowerCase()).first<UserRow>();
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
