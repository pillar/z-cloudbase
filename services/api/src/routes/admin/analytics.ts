import {
  ANALYTICS_CUSTOM_DIMENSIONS_MAX, ApiError, BREAKDOWN_MAX_ROWS, ENVIRONMENTS, EVENT_NAME_RE, EXPLORER_MAX_PAGE, EXPORT_MAX_DAYS,
  FUNNEL_DEFAULT_WINDOW_S, FUNNEL_MAX_STEPS, FUNNEL_MAX_WINDOW_S, FUNNEL_MIN_STEPS, RETENTION_MAX_PERIODS, UpdateAnalyticsSettingsRequest,
  type AnalyticsSettings, type Environment,
} from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { funnel, retention } from '../../lib/analytics/actors.ts';
import { parseFilter, parseUserPropertyFilter, resolveDimension } from '../../lib/analytics/dimensions.ts';
import { exploreEvents } from '../../lib/analytics/explorer.ts';
import { exportStream, listExportObjects, suppressedKeys } from '../../lib/analytics/export.ts';
import { analyticsQuery } from '../../lib/analytics/index.ts';
import { analyticsRetentionDays, archiveRetentionDays, dayRange } from '../../lib/analytics/range.ts';
import { customDimensions } from '../../lib/events/ingest.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadEnvId, readJson, readQuery, type C } from './util.ts';

// Funnels, retention, breakdown, event explorer, settings and raw export (PRD §21.8, §21.9). Product and env
// come from the path and query and are authorized before any data is read; every query is scoped to that
// product environment.
export const analyticsRoutes = new Hono<AppEnv>();

const EnvQuery = z.object({ env: z.enum(ENVIRONMENTS) });
const EventName = z.string().regex(EVENT_NAME_RE);
const DateParam = z.iso.date().optional();

/** Authorize `action` on the product env named by the path / query and resolve its id (403 before 404, no leak). */
async function scope(c: C, action: 'analytics:read' | 'analytics:export' | 'product:write'): Promise<{ productId: string; env: Environment; productEnvId: string }> {
  const productId = c.req.param('id')!;
  const { env } = readQuery(c, EnvQuery.passthrough());
  authorize(c, action, { productId, env });
  return { productId, env, productEnvId: await loadEnvId(c, productId, env) };
}

const many = (c: C, name: string) => c.req.queries(name) ?? [];

analyticsRoutes.get('/products/:id/analytics/funnel', async (c) => {
  const s = await scope(c, 'analytics:read');
  const q = readQuery(c, z.object({
    env: z.string(), from: DateParam, to: DateParam,
    window: z.coerce.number().int().min(60).max(FUNNEL_MAX_WINDOW_S).default(FUNNEL_DEFAULT_WINDOW_S),
    filter: z.string().optional(), user_property: z.string().optional(),
  }).passthrough());
  const steps = many(c, 'steps').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (steps.length < FUNNEL_MIN_STEPS || steps.length > FUNNEL_MAX_STEPS || !steps.every((x) => EventName.safeParse(x).success)) {
    throw new ApiError('validation_failed', `steps must be ${FUNNEL_MIN_STEPS}–${FUNNEL_MAX_STEPS} event names`);
  }
  const declared = await customDimensions(c.env.INGEST_DB, s.productEnvId);
  const filter = q.filter ? parseFilter(q.filter, declared) : undefined;
  if (filter?.dim.name === 'event_name') throw new ApiError('validation_failed', 'The first-step filter cannot be event_name');
  const range = dayRange(q, analyticsRetentionDays(c.env));
  return c.json(await funnel(c.env.INGEST_DB, {
    productEnvId: s.productEnvId, steps, fromDay: range.fromDay, toDay: range.toDay, windowS: q.window, filter,
    userProperty: q.user_property ? parseUserPropertyFilter(q.user_property) : undefined,
  }));
});

analyticsRoutes.get('/products/:id/analytics/retention', async (c) => {
  const s = await scope(c, 'analytics:read');
  const q = readQuery(c, z.object({
    env: z.string(), from: DateParam, to: DateParam,
    granularity: z.enum(['day', 'week']).default('day'),
    periods: z.coerce.number().int().min(1).optional(),
    start_event: EventName.optional(), return_event: EventName.optional(), user_property: z.string().optional(),
  }));
  const max = RETENTION_MAX_PERIODS[q.granularity];
  const periods = q.periods ?? (q.granularity === 'day' ? 7 : 4);
  if (periods > max) throw new ApiError('validation_failed', `periods must be at most ${max} for ${q.granularity}`);
  const range = dayRange(q, analyticsRetentionDays(c.env), Date.now(), q.granularity === 'day' ? 14 : 56);
  const maxCohortDays = q.granularity === 'day' ? 31 : 91;
  if (range.toDay - range.fromDay > maxCohortDays) throw new ApiError('validation_failed', `The cohort range is limited to ${maxCohortDays} days`);
  return c.json(await retention(c.env.INGEST_DB, {
    productEnvId: s.productEnvId, granularity: q.granularity, periods, fromDay: range.fromDay, toDay: range.toDay,
    startEvent: q.start_event, returnEvent: q.return_event,
    userProperty: q.user_property ? parseUserPropertyFilter(q.user_property) : undefined,
  }));
});

analyticsRoutes.get('/products/:id/analytics/breakdown', async (c) => {
  const s = await scope(c, 'analytics:read');
  const q = readQuery(c, z.object({
    env: z.string(), from: DateParam, to: DateParam, by: z.string().min(1), event: EventName.optional(),
    limit: z.coerce.number().int().min(1).max(BREAKDOWN_MAX_ROWS).default(20),
  }).passthrough());
  const declared = await customDimensions(c.env.INGEST_DB, s.productEnvId);
  const filters = many(c, 'filter').map((f) => parseFilter(f, declared));
  if (filters.length > 3) throw new ApiError('validation_failed', 'At most 3 filters');
  const range = dayRange(q, analyticsRetentionDays(c.env));
  const result = await analyticsQuery(c.env).breakdown({
    productEnvId: s.productEnvId, fromDay: range.fromDay, toDay: range.toDay, by: resolveDimension(q.by, declared), event: q.event, filters, limit: q.limit,
  });
  return c.json({ ...result, from: range.from, to: range.to });
});

analyticsRoutes.get('/products/:id/analytics/events', async (c) => {
  const s = await scope(c, 'analytics:read');
  const q = readQuery(c, z.object({
    env: z.string(), from: DateParam, to: DateParam, event: EventName.optional(), actor: z.string().min(1).max(200).optional(),
    before: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(EXPLORER_MAX_PAGE).default(50),
  }).passthrough());
  const declared = await customDimensions(c.env.INGEST_DB, s.productEnvId);
  const filters = many(c, 'filter').map((f) => parseFilter(f, declared));
  if (filters.length > 3) throw new ApiError('validation_failed', 'At most 3 filters');
  const range = dayRange(q, analyticsRetentionDays(c.env));
  return c.json(await exploreEvents(c.env.INGEST_DB, {
    productEnvId: s.productEnvId, fromDay: range.fromDay, toDay: range.toDay, event: q.event, actor: q.actor, filters, before: q.before, limit: q.limit,
  }));
});

analyticsRoutes.get('/products/:id/analytics/settings', async (c) => {
  const s = await scope(c, 'analytics:read');
  const body: AnalyticsSettings = {
    dimensions: await customDimensions(c.env.INGEST_DB, s.productEnvId),
    retention_days: analyticsRetentionDays(c.env),
    archive_retention_days: archiveRetentionDays(c.env),
  };
  return c.json(body);
});

analyticsRoutes.put('/products/:id/analytics/settings', async (c) => {
  const s = await scope(c, 'product:write');
  const body = await readJson(c, UpdateAnalyticsSettingsRequest);
  if (body.dimensions.length > ANALYTICS_CUSTOM_DIMENSIONS_MAX) throw new ApiError('validation_failed', `At most ${ANALYTICS_CUSTOM_DIMENSIONS_MAX} dimensions`);
  const now = Date.now();
  // Settings live in the ingest database; the audit row in the platform database is written right after.
  await c.env.INGEST_DB.prepare(
    `INSERT INTO analytics_settings (product_env_id, dimensions, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (product_env_id) DO UPDATE SET dimensions = excluded.dimensions, updated_at = excluded.updated_at`,
  ).bind(s.productEnvId, JSON.stringify(body.dimensions), now).run();
  await adminAudit(c, {
    action: 'analytics.settings_updated', productId: s.productId, env: s.env, targetType: 'product_environment', targetId: s.productEnvId,
    metadata: { dimensions: body.dimensions },
  }).run();
  const res: AnalyticsSettings = { dimensions: body.dimensions, retention_days: analyticsRetentionDays(c.env), archive_retention_days: archiveRetentionDays(c.env) };
  return c.json(res);
});

analyticsRoutes.get('/products/:id/analytics/export', async (c) => {
  const s = await scope(c, 'analytics:export');
  const q = readQuery(c, z.object({ env: z.string(), from: z.iso.date(), to: z.iso.date(), format: z.enum(['ndjson', 'csv']).default('ndjson') }));
  const range = dayRange(q, archiveRetentionDays(c.env));
  if (range.toDay - range.fromDay > EXPORT_MAX_DAYS) throw new ApiError('validation_failed', `An export covers at most ${EXPORT_MAX_DAYS} days`);
  const days = await listExportObjects(c.env.ARCHIVE, { productId: s.productId, env: s.env, fromDay: range.fromDay, toDay: range.toDay, format: q.format });
  const objects = days.reduce((n, d) => n + d.keys.length, 0);
  await adminAudit(c, {
    action: 'analytics.exported', productId: s.productId, env: s.env, targetType: 'product_environment', targetId: s.productEnvId,
    metadata: { from: range.from, to: range.to, format: q.format, objects },
  }).run();
  const { stream } = exportStream(c.env.ARCHIVE, days, await suppressedKeys(c.env.INGEST_DB, s.productEnvId), q.format);
  const filename = `${s.productId}-${s.env}-events-${range.from}-${range.to}.${q.format}`;
  return new Response(stream, {
    headers: {
      'content-type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});
