import {
  ApiError, CreateProductRequest, DEFAULT_DAILY_UPLOAD_BYTES, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_PRODUCT_QUOTA_BYTES, ENVIRONMENTS, RESERVED_PRODUCT_IDS,
  UpdateEnvironmentRequest, UpdateProductRequest, clientId, newPublishableKey, randomBase62, type Environment,
} from '@z-cloudbase/contracts';
import { visibleProducts } from '@z-cloudbase/security';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../context.ts';
import { identity } from '../../identity.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadProduct, parseEnv, readJson, type ProductRow } from './util.ts';

export const productRoutes = new Hono<AppEnv>();

const toProduct = (r: ProductRow) => ({
  ...r,
  redirect_uris: JSON.parse(r.redirect_uris) as string[],
  allowed_origins: JSON.parse(r.allowed_origins) as string[],
});

interface EnvRow {
  id: string;
  env: Environment;
  publishable_key: string;
  storage_quota_bytes: number;
  max_object_bytes: number;
  allowed_mime_types: string;
  allowed_extensions: string;
  daily_upload_quota_bytes: number;
  unknown_event_policy: string;
  created_at: number;
}

const parseEnvRow = (e: EnvRow) => ({
  ...e,
  allowed_mime_types: JSON.parse(e.allowed_mime_types) as string[],
  allowed_extensions: JSON.parse(e.allowed_extensions) as string[],
});

const ENV_COLUMNS =
  'id, env, publishable_key, storage_quota_bytes, max_object_bytes, allowed_mime_types, allowed_extensions, daily_upload_quota_bytes, unknown_event_policy, created_at';

async function loadEnvironments(db: D1Database, productId: string) {
  const { results } = await db.prepare(`SELECT ${ENV_COLUMNS} FROM product_environments WHERE product_id = ?`).bind(productId).all<EnvRow>();
  return results
    .map(parseEnvRow)
    .sort((a, b) => ENVIRONMENTS.indexOf(a.env) - ENVIRONMENTS.indexOf(b.env));
}

productRoutes.post('/products', async (c) => {
  authorize(c, 'platform:manage');
  const body = await readJson(c, CreateProductRequest);
  if (RESERVED_PRODUCT_IDS.includes(body.product_id)) throw new ApiError('validation_failed', 'product_id is reserved');
  const taken = await c.env.DB.prepare('SELECT 1 AS x FROM products WHERE id = ?').bind(body.product_id).first();
  if (taken) throw new ApiError('conflict', 'product_id already exists');

  // OIDC clients first: they are idempotent, so a failure here leaves no half-created product to clean up.
  for (const env of ENVIRONMENTS) {
    await identity(c.env).upsertProductClient({ productId: body.product_id, env, redirectUris: body.redirect_uris, type: 'public' });
  }

  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (id, name, status, visibility, redirect_uris, allowed_origins, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .bind(body.product_id, body.name, body.visibility, JSON.stringify(body.redirect_uris), JSON.stringify(body.allowed_origins), now, now),
    ...ENVIRONMENTS.map((env) =>
      db
        .prepare(
          `INSERT INTO product_environments (id, product_id, env, publishable_key, user_key_salt, storage_quota_bytes, max_object_bytes, allowed_mime_types, allowed_extensions, daily_upload_quota_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
        )
        .bind(clientId(body.product_id, env), body.product_id, env, newPublishableKey(env), randomBase62(32), DEFAULT_PRODUCT_QUOTA_BYTES, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_DAILY_UPLOAD_BYTES, now),
    ),
    adminAudit(c, { action: 'product.create', productId: body.product_id, targetType: 'product', targetId: body.product_id, metadata: { name: body.name } }),
  ]);
  const product = toProduct(await loadProduct(c, body.product_id));
  return c.json({ ...product, environments: await loadEnvironments(db, body.product_id) }, 201);
});

productRoutes.get('/products', async (c) => {
  // The listing is the authorization: visibleProducts() yields exactly the products the principal may read.
  const visible = visibleProducts(c.get('admin').grants);
  const cols = 'SELECT id, name, status, visibility, created_at, updated_at FROM products';
  const stmt =
    visible === 'all'
      ? c.env.DB.prepare(`${cols} ORDER BY created_at DESC`)
      : c.env.DB.prepare(`${cols} WHERE id IN (${visible.map(() => '?').join(',') || "''"}) ORDER BY created_at DESC`).bind(...visible);
  return c.json({ products: (await stmt.all()).results });
});

productRoutes.get('/products/:id', async (c) => {
  const id = c.req.param('id');
  authorize(c, 'product:read', { productId: id });
  const product = toProduct(await loadProduct(c, id));
  return c.json({ ...product, environments: await loadEnvironments(c.env.DB, id) });
});

productRoutes.patch('/products/:id', async (c) => {
  const id = c.req.param('id');
  authorize(c, 'product:write', { productId: id });
  const body = await readJson(c, UpdateProductRequest);
  if (Object.keys(body).length === 0) throw new ApiError('validation_failed', 'No fields to update');
  // Disabling/archiving (and re-enabling) is a platform decision: a product admin must not lift an owner's suspension.
  if (body.status !== undefined) authorize(c, 'platform:manage');
  await loadProduct(c, id);

  // Re-sync OIDC clients before touching the DB so a failed sync leaves the product unchanged.
  if (body.redirect_uris) {
    for (const e of await loadEnvironments(c.env.DB, id)) {
      await identity(c.env).upsertProductClient({ productId: id, env: e.env, redirectUris: body.redirect_uris, type: 'public' });
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), values.push(v));
  if (body.name !== undefined) set('name', body.name);
  if (body.visibility !== undefined) set('visibility', body.visibility);
  if (body.status !== undefined) set('status', body.status);
  if (body.redirect_uris !== undefined) set('redirect_uris', JSON.stringify(body.redirect_uris));
  if (body.allowed_origins !== undefined) set('allowed_origins', JSON.stringify(body.allowed_origins));
  set('updated_at', Date.now());
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id),
    adminAudit(c, { action: 'product.update', productId: id, targetType: 'product', targetId: id, metadata: { changes: body } }),
  ]);
  return c.json(toProduct(await loadProduct(c, id)));
});

async function loadEnvSettings(c: Context<AppEnv>, productId: string, env: Environment) {
  const row = await c.env.DB.prepare(`SELECT ${ENV_COLUMNS} FROM product_environments WHERE product_id = ? AND env = ?`).bind(productId, env).first<EnvRow>();
  if (!row) throw new ApiError('not_found', 'Product environment not found');
  return parseEnvRow(row);
}

productRoutes.get('/products/:id/environments/:env', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'product:read', { productId, env });
  return c.json(await loadEnvSettings(c, productId, env));
});

productRoutes.patch('/products/:id/environments/:env', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'product:write', { productId, env });
  const body = await readJson(c, UpdateEnvironmentRequest);
  if (Object.keys(body).length === 0) throw new ApiError('validation_failed', 'No fields to update');
  const before = await loadEnvSettings(c, productId, env);

  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), values.push(v));
  if (body.storage_quota_bytes !== undefined) set('storage_quota_bytes', body.storage_quota_bytes);
  if (body.max_object_bytes !== undefined) set('max_object_bytes', body.max_object_bytes);
  if (body.allowed_mime_types !== undefined) set('allowed_mime_types', JSON.stringify(body.allowed_mime_types));
  if (body.allowed_extensions !== undefined) set('allowed_extensions', JSON.stringify(body.allowed_extensions));
  if (body.daily_upload_quota_bytes !== undefined) set('daily_upload_quota_bytes', body.daily_upload_quota_bytes);
  if (body.unknown_event_policy !== undefined) set('unknown_event_policy', body.unknown_event_policy);

  const pick = (e: ReturnType<typeof parseEnvRow>) => Object.fromEntries(Object.keys(body).map((k) => [k, e[k as keyof typeof e]]));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE product_environments SET ${sets.join(', ')} WHERE id = ?`).bind(...values, before.id),
    adminAudit(c, {
      action: 'environment.update', productId, env, targetType: 'product_environment', targetId: before.id,
      metadata: { before: pick(before), after: body },
    }),
  ]);
  return c.json(await loadEnvSettings(c, productId, env));
});
