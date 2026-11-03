import { ApiError, CreateServiceKeyRequest, ENVIRONMENTS, newId, newPublishableKey, newServiceKey } from '@z-cloudbase/contracts';
import { can, sha256Hex } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadEnvId, loadProduct, parseEnv, readJson, readQuery } from './util.ts';

export const keyRoutes = new Hono<AppEnv>();

interface CredentialRow {
  id: string;
  env: string;
  label: string | null;
  scopes: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toKey = (r: CredentialRow) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] });

// Plaintext is returned exactly once, here; only the SHA-256 is stored (PRD §19.3).
keyRoutes.post('/products/:id/service-keys', async (c) => {
  const productId = c.req.param('id');
  const body = await readJson(c, CreateServiceKeyRequest);
  authorize(c, 'keys:manage', { productId, env: body.env });
  await loadProduct(c, productId);
  const productEnvId = await loadEnvId(c, productId, body.env);

  const key = newServiceKey(body.env);
  const id = newId('cred');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO service_credentials (id, product_env_id, label, scopes, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, productEnvId, body.label ?? null, JSON.stringify(body.scopes), await sha256Hex(key), c.get('admin').userId, now),
    adminAudit(c, {
      action: 'service_key.create', productId, env: body.env, targetType: 'service_credential', targetId: id,
      metadata: { scopes: body.scopes, label: body.label ?? null },
    }),
  ]);
  return c.json({ id, env: body.env, label: body.label ?? null, scopes: body.scopes, created_at: now, key }, 201);
});

keyRoutes.get('/products/:id/service-keys', async (c) => {
  const productId = c.req.param('id');
  const q = readQuery(c, z.object({ env: z.enum(ENVIRONMENTS).optional() }));
  // Only list the environments the caller may manage keys for (developers: never prod).
  const envs = (q.env ? [q.env] : [...ENVIRONMENTS]).filter((env) => can(c.get('admin').grants, 'keys:manage', { productId, env }));
  if (envs.length === 0) authorize(c, 'keys:manage', { productId, env: q.env ?? 'prod' });
  await loadProduct(c, productId);
  const { results } = await c.env.DB.prepare(
    `SELECT sc.id, pe.env, sc.label, sc.scopes, sc.created_by, sc.created_at, sc.last_used_at, sc.revoked_at
     FROM service_credentials sc JOIN product_environments pe ON pe.id = sc.product_env_id
     WHERE pe.product_id = ? AND pe.env IN (${envs.map(() => '?').join(',')}) ORDER BY sc.created_at DESC`,
  ).bind(productId, ...envs).all<CredentialRow>();
  return c.json({ keys: results.map(toKey) });
});

keyRoutes.delete('/products/:id/service-keys/:keyId', async (c) => {
  const productId = c.req.param('id');
  const keyId = c.req.param('keyId');
  authorize(c, 'product:read', { productId }); // must belong to this product's team before anything is looked up
  const row = await c.env.DB.prepare(
    `SELECT sc.id, pe.env, sc.revoked_at FROM service_credentials sc JOIN product_environments pe ON pe.id = sc.product_env_id
     WHERE sc.id = ? AND pe.product_id = ?`,
  ).bind(keyId, productId).first<{ id: string; env: 'dev' | 'staging' | 'prod'; revoked_at: number | null }>();
  if (!row) throw new ApiError('not_found', 'Service key not found');
  authorize(c, 'keys:manage', { productId, env: row.env });

  const now = Date.now();
  const stmts = [adminAudit(c, { action: 'service_key.revoke', productId, env: row.env, targetType: 'service_credential', targetId: keyId })];
  if (row.revoked_at === null) {
    stmts.unshift(c.env.DB.prepare('UPDATE service_credentials SET revoked_at = ? WHERE id = ?').bind(now, keyId));
  }
  await c.env.DB.batch(stmts);
  return c.json({ id: keyId, revoked_at: row.revoked_at ?? now });
});

keyRoutes.post('/products/:id/environments/:env/publishable-key/rotate', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'keys:manage', { productId, env });
  const productEnvId = await loadEnvId(c, productId, env);
  const key = newPublishableKey(env);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE product_environments SET publishable_key = ? WHERE id = ?').bind(key, productEnvId),
    adminAudit(c, { action: 'publishable_key.rotate', productId, env, targetType: 'product_environment', targetId: productEnvId }),
  ]);
  return c.json({ env, publishable_key: key });
});
