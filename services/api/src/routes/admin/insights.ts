import { ANALYTICS_QUERY_WINDOW_DAYS, ApiError, ENVIRONMENTS, LOG_LEVELS, PRODUCT_ID_RE } from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { analyticsQuery } from '../../lib/analytics/index.ts';
import { decodeLogCursor, searchLogs } from '../../lib/logsearch/index.ts';
import { authorize } from '../../middleware/auth.ts';
import { loadEnvId, loadProduct, readQuery } from './util.ts';

// Read-only views: audit trail, usage estimate, analytics summary, log search.
export const insightRoutes = new Hono<AppEnv>();

const DAY_MS = 24 * 3600 * 1000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DateTime = z.iso.datetime({ offset: true });

const AuditQuery = z.object({
  product_id: z.string().regex(PRODUCT_ID_RE).optional(),
  from: DateTime.optional(),
  to: DateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** With `product_id`: that product's trail. Without: the platform-wide trail (owner/operator only). */
insightRoutes.get('/audit', async (c) => {
  const q = readQuery(c, AuditQuery);
  authorize(c, 'audit:read', q.product_id ? { productId: q.product_id } : {});
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.product_id) (where.push('product_id = ?'), args.push(q.product_id));
  if (q.from) (where.push('occurred_at >= ?'), args.push(Date.parse(q.from)));
  if (q.to) (where.push('occurred_at < ?'), args.push(Date.parse(q.to)));
  const { results } = await c.env.DB.prepare(
    `SELECT id, occurred_at, actor_type, actor_id, action, product_id, env, target_type, target_id, request_id, metadata
     FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
  ).bind(...args, q.limit).all<{ metadata: string }>();
  return c.json({ entries: results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) as unknown })) });
});

const UsageQuery = z.object({ env: z.enum(ENVIRONMENTS).optional() });
const USAGE_WINDOW_DAYS = 30;

insightRoutes.get('/products/:id/usage', async (c) => {
  const productId = c.req.param('id');
  const q = readQuery(c, UsageQuery);
  authorize(c, 'storage:read_meta', { productId });
  authorize(c, 'analytics:read', { productId });
  await loadProduct(c, productId);
  const { results: envs } = await c.env.DB.prepare(
    'SELECT id, env, storage_quota_bytes FROM product_environments WHERE product_id = ?',
  ).bind(productId).all<{ id: string; env: string; storage_quota_bytes: number }>();

  const now = Date.now();
  const usage = [];
  for (const e of envs.filter((x) => !q.env || x.env === q.env)) {
    const s = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS objects FROM storage_objects WHERE product_env_id = ? AND status = 'available'",
    ).bind(e.id).first<{ bytes: number; objects: number }>();
    let events: { total: number; source: string } | null = null;
    try {
      const a = await analyticsQuery(c.env).summary({ productEnvId: e.id, from: isoDate(now - (USAGE_WINDOW_DAYS - 1) * DAY_MS), to: isoDate(now + DAY_MS) });
      events = { total: a.events_total, source: a.source };
    } catch (err) {
      console.error(JSON.stringify({ request_id: c.get('requestId'), usage_events_error: String(err) }));
    }
    usage.push({
      env: e.env,
      storage: { bytes: s?.bytes ?? 0, objects: s?.objects ?? 0, quota_bytes: e.storage_quota_bytes },
      events: events && { ...events, window_days: USAGE_WINDOW_DAYS },
    });
  }
  return c.json({ estimate: true, usage });
});

const AnalyticsQuerySchema = z.object({
  env: z.enum(ENVIRONMENTS),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

insightRoutes.get('/products/:id/analytics', async (c) => {
  const productId = c.req.param('id');
  const q = readQuery(c, AnalyticsQuerySchema);
  authorize(c, 'analytics:read', { productId, env: q.env });
  const productEnvId = await loadEnvId(c, productId, q.env);
  const now = Date.now();
  const from = q.from ?? isoDate(now - 6 * DAY_MS);
  const to = q.to ?? isoDate(now + DAY_MS);
  if (from >= to) throw new ApiError('validation_failed', 'from must be before to');
  return c.json({ ...(await analyticsQuery(c.env).summary({ productEnvId, from, to })), window_days_max: ANALYTICS_QUERY_WINDOW_DAYS });
});

const LogsQuery = z.object({
  env: z.enum(ENVIRONMENTS),
  request_id: z.string().min(1).max(128).optional(),
  level: z.enum(LOG_LEVELS).optional(),
  from: DateTime.optional(),
  to: DateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().min(1).max(1100).optional(),
});

insightRoutes.get('/products/:id/logs', async (c) => {
  const productId = c.req.param('id');
  const q = readQuery(c, LogsQuery);
  authorize(c, 'logs:read', { productId, env: q.env });
  const productEnvId = await loadEnvId(c, productId, q.env);
  const now = Date.now();
  const from = q.from ? Date.parse(q.from) : now - DAY_MS;
  const to = q.to ? Date.parse(q.to) : now + 1000;
  if (from >= to) throw new ApiError('validation_failed', 'from must be before to');
  const before = q.before === undefined ? undefined : decodeLogCursor(q.before);
  if (before === null) throw new ApiError('validation_failed', 'Invalid before cursor');
  // Newest first; `next_before` continues with older entries (same filters and window).
  return c.json(await searchLogs(c.env, {
    productEnvId, from, to, limit: q.limit,
    ...(q.request_id ? { requestId: q.request_id } : {}),
    ...(q.level ? { level: q.level } : {}),
    ...(before ? { before } : {}),
  }));
});
