import { ApiError, newId, type MeResponse, type SelfServiceRequest, type SelfServiceRequestList } from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { requestAuditStatement } from '../../lib/audit.ts';
import { identity } from '../../identity.ts';
import { denyImpersonation, withCredential, withUser } from '../../middleware/auth.ts';

// Self-service for the end user of ONE product. There is deliberately no endpoint listing the
// user's other products, nor account-level deletion / export: both act across products and live on
// the identity domain (session cookie + re-authentication), see services/identity/src/account.ts.
export const meRoutes = new Hono<AppEnv>();

meRoutes.use(withCredential({ allow: ['publishable'] }), withUser({ required: true }));

interface RequestRow {
  id: string;
  kind: 'delete' | 'export';
  scope: 'account' | 'product';
  status: SelfServiceRequest['status'];
  requested_at: number;
  due_at: number;
  completed_at: number | null;
}

// result_ref (internal storage path of an export) is intentionally not exposed.
const REQUEST_COLUMNS = 'id, kind, scope, status, requested_at, due_at, completed_at';
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const toRequest = (r: RequestRow): SelfServiceRequest => ({
  id: r.id, kind: r.kind, scope: r.scope, status: r.status,
  requested_at: iso(r.requested_at)!, due_at: iso(r.due_at)!, completed_at: iso(r.completed_at),
});

meRoutes.get('/', async (c) => {
  const cred = c.get('cred');
  const user = c.get('user')!;
  const m = await c.env.DB.prepare('SELECT status, joined_at FROM product_memberships WHERE user_id = ? AND product_id = ?')
    .bind(user.userId, cred.productId).first<{ status: MeResponse['membership']['status']; joined_at: number }>();
  return c.json({
    user_id: user.userId,
    anonymous: user.anon,
    product_id: cred.productId,
    env: cred.env,
    membership: { status: m!.status, joined_at: iso(m!.joined_at)! },
  } satisfies MeResponse);
});

/** Leave this product: tokens first (retryable if the RPC fails), then membership + cleanup request + audit atomically. */
meRoutes.delete('/membership', denyImpersonation(), async (c) => {
  const cred = c.get('cred');
  const { userId } = c.get('user')!;
  try {
    await identity(c.env).revokeUserTokens({ userId, productId: cred.productId, reason: 'leave_product' });
  } catch (e) {
    console.error(JSON.stringify({ request_id: c.get('requestId'), error: String(e), op: 'revokeUserTokens' }));
    throw new ApiError('unavailable', 'Could not revoke tokens; try again');
  }
  const now = Date.now();
  const requestId = newId('del');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE product_memberships SET status = 'revoked' WHERE user_id = ? AND product_id = ?`).bind(userId, cred.productId),
    // The consumer deletes this user's storage objects in the product and marks the request completed (PRD §19.8).
    c.env.DB.prepare(
      `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, 'delete', 'product', ?, 'pending', ?, ?)`,
    ).bind(requestId, userId, cred.productId, now, now),
    requestAuditStatement(c, {
      actorType: 'user', actorId: userId, action: 'me.membership.leave', productId: cred.productId, env: cred.env,
      targetType: 'deletion_request', targetId: requestId,
    }),
  ]);
  return c.body(null, 204);
});

/**
 * This product's leave-product requests of the user only. Account-level deletion / export requests
 * belong to the identity domain (user center) and are not visible to products (PRD §19.8).
 */
meRoutes.get('/requests', async (c) => {
  const { userId } = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM deletion_requests WHERE user_id = ? AND scope = 'product' AND product_id = ? ORDER BY requested_at DESC, id DESC LIMIT 50`,
  ).bind(userId, c.get('cred').productId).all<RequestRow>();
  return c.json({ requests: results.map(toRequest) } satisfies SelfServiceRequestList);
});
