import { AddTeamMemberRequest, ApiError, newId } from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, isUniqueViolation, loadProduct, readJson } from './util.ts';

export const teamRoutes = new Hono<AppEnv>();

interface TeamRow {
  id: string;
  user_id: string;
  role: string;
  product_id: string | null;
  created_by: string | null;
  created_at: number;
}

const COLS = 'id, user_id, role, product_id, created_by, created_at';
const isPlatformRole = (role: string) => role === 'owner' || role === 'operator';

/** Platform roles need platform:manage; product roles need team:manage within their own product. */
function authorizeTeamChange(c: Parameters<typeof authorize>[0], role: string, productId: string | null) {
  if (isPlatformRole(role)) authorize(c, 'platform:manage');
  else authorize(c, 'team:manage', { productId: productId ?? undefined });
}

teamRoutes.get('/team', async (c) => {
  authorize(c, 'platform:manage');
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM team_members ORDER BY created_at`).all<TeamRow>();
  return c.json({ members: results });
});

teamRoutes.get('/products/:id/team', async (c) => {
  const productId = c.req.param('id');
  authorize(c, 'team:manage', { productId });
  await loadProduct(c, productId);
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM team_members WHERE product_id = ? ORDER BY created_at`)
    .bind(productId).all<TeamRow>();
  return c.json({ members: results });
});

teamRoutes.post('/team', async (c) => {
  const body = await readJson(c, AddTeamMemberRequest);
  const platformRole = isPlatformRole(body.role);
  if (platformRole === (body.product_id !== undefined)) {
    throw new ApiError('validation_failed', 'owner/operator take no product_id; product roles require one');
  }
  authorizeTeamChange(c, body.role, body.product_id ?? null);
  if (body.product_id) await loadProduct(c, body.product_id);
  const user = await c.env.DB.prepare('SELECT 1 AS x FROM "user" WHERE id = ? AND deletedAt IS NULL').bind(body.user_id).first();
  if (!user) throw new ApiError('not_found', 'User not found');

  const id = newId('tm');
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO team_members (id, user_id, role, product_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, body.user_id, body.role, body.product_id ?? null, c.get('admin').userId, now),
      adminAudit(c, {
        action: 'team.add', productId: body.product_id ?? null, targetType: 'team_member', targetId: id,
        metadata: { user_id: body.user_id, role: body.role },
      }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('conflict', 'User already has this role');
    throw e;
  }
  return c.json({ id, user_id: body.user_id, role: body.role, product_id: body.product_id ?? null, created_by: c.get('admin').userId, created_at: now }, 201);
});

teamRoutes.delete('/team/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM team_members WHERE id = ?`).bind(id).first<TeamRow>();
  if (!row) {
    authorize(c, 'platform:manage'); // do not reveal anything to callers who could not remove any member anyway
    throw new ApiError('not_found', 'Team member not found');
  }
  authorizeTeamChange(c, row.role, row.product_id);
  if (row.role === 'owner') {
    const owners = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE role = 'owner'").first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) throw new ApiError('invalid_request', 'Cannot remove the last owner');
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM team_members WHERE id = ?').bind(id),
    adminAudit(c, {
      action: 'team.remove', productId: row.product_id, targetType: 'team_member', targetId: id,
      metadata: { user_id: row.user_id, role: row.role },
    }),
  ]);
  return c.body(null, 204);
});
