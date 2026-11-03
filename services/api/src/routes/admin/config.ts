import { ApiError, BUCKET_NAME_RE, RegisterEventSchemaRequest, newId } from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, isUniqueViolation, loadEnvId, parseEnv, readJson } from './util.ts';

// Per-environment configuration: storage buckets and event schemas.
export const configRoutes = new Hono<AppEnv>();

const CreateBucketRequest = z.object({
  name: z.string().regex(BUCKET_NAME_RE),
  visibility: z.enum(['private', 'public']).default('private'),
});


configRoutes.post('/products/:id/environments/:env/buckets', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'product:write', { productId, env });
  const body = await readJson(c, CreateBucketRequest);
  const productEnvId = await loadEnvId(c, productId, env);
  const id = newId('bkt');
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO storage_buckets (id, product_env_id, name, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, productEnvId, body.name, body.visibility, now),
      adminAudit(c, { action: 'bucket.create', productId, env, targetType: 'storage_bucket', targetId: id, metadata: { name: body.name, visibility: body.visibility } }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('conflict', 'Bucket already exists');
    throw e;
  }
  return c.json({ id, name: body.name, visibility: body.visibility, created_at: now }, 201);
});

configRoutes.get('/products/:id/environments/:env/buckets', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'storage:read_meta', { productId, env });
  const productEnvId = await loadEnvId(c, productId, env);
  const { results } = await c.env.DB.prepare('SELECT id, name, visibility, created_at FROM storage_buckets WHERE product_env_id = ? ORDER BY name')
    .bind(productEnvId).all();
  return c.json({ buckets: results });
});

configRoutes.post('/products/:id/environments/:env/event-schemas', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'product:write', { productId, env });
  const body = await readJson(c, RegisterEventSchemaRequest);
  const productEnvId = await loadEnvId(c, productId, env);
  const id = newId('evs');
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO event_schemas (id, product_env_id, event_name, schema_version, json_schema, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, productEnvId, body.event_name, body.schema_version, JSON.stringify(body.schema), now),
      adminAudit(c, {
        action: 'event_schema.register', productId, env, targetType: 'event_schema', targetId: id,
        metadata: { event_name: body.event_name, schema_version: body.schema_version },
      }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('conflict', 'This event schema version is already registered');
    throw e;
  }
  return c.json({ id, event_name: body.event_name, schema_version: body.schema_version, schema: body.schema, created_at: now }, 201);
});

configRoutes.get('/products/:id/environments/:env/event-schemas', async (c) => {
  const productId = c.req.param('id');
  const env = parseEnv(c.req.param('env'));
  authorize(c, 'product:read', { productId, env });
  const productEnvId = await loadEnvId(c, productId, env);
  const { results } = await c.env.DB.prepare(
    'SELECT id, event_name, schema_version, json_schema, created_at FROM event_schemas WHERE product_env_id = ? ORDER BY event_name, schema_version',
  ).bind(productEnvId).all<{ id: string; event_name: string; schema_version: number; json_schema: string; created_at: number }>();
  return c.json({
    event_schemas: results.map((r) => ({
      id: r.id, event_name: r.event_name, schema_version: r.schema_version, schema: JSON.parse(r.json_schema) as unknown, created_at: r.created_at,
    })),
  });
});
