// Product webhook endpoints (PRD §21.6): per product environment; the signing secret is shown once (create,
// rotate); delivery log per endpoint. Reads need `webhooks:read`, changes `webhooks:manage` (developers:
// non-production only). An endpoint of another product environment is `not_found`.
import {
  ApiError, CreateWebhookRequest, UpdateWebhookRequest, WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT, WEBHOOK_MAX_ENDPOINTS_PER_ENV,
  WEBHOOK_SECRET_GRACE_S, newId, type Environment, type WebhookEndpoint, type WebhookEventType,
} from '@z-cloudbase/contracts';
import { checkWebhookUrl, newWebhookSecret, type Action } from '@z-cloudbase/security';
import { deliverMessages, testMessageStatements } from '@z-cloudbase/webhooks';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { prepareAll, webhookFetch } from '../../lib/webhooks.ts';
import { authorize } from '../../middleware/auth.ts';
import { adminAudit, loadEnvId, loadProduct, parseEnv, readJson, readQuery, type C } from './util.ts';

export const webhookRoutes = new Hono<AppEnv>();

const BASE = '/products/:id/environments/:env/webhooks';

interface EndpointRow {
  id: string;
  product_env_id: string;
  url: string;
  description: string | null;
  event_types: string;
  enabled: number;
  previous_secret_expires_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const COLS = 'id, product_env_id, url, description, event_types, enabled, previous_secret_expires_at, created_by, created_at, updated_at';

const toEndpoint = (r: EndpointRow, productId: string, env: Environment): WebhookEndpoint & { previous_secret_expires_at: number | null } => ({
  id: r.id, product_id: productId, env, url: r.url, description: r.description,
  event_types: JSON.parse(r.event_types) as WebhookEventType[], enabled: Boolean(r.enabled),
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  // Set while the previous secret still signs (rotation grace).
  previous_secret_expires_at: r.previous_secret_expires_at && r.previous_secret_expires_at > Date.now() ? r.previous_secret_expires_at : null,
});

/** Authorize first (no existence oracle for other products), then resolve the environment. */
async function scope(c: C, action: Action) {
  const productId = c.req.param('id')!;
  const env = parseEnv(c.req.param('env'));
  authorize(c, action, { productId, env });
  await loadProduct(c, productId);
  return { productId, env, productEnvId: await loadEnvId(c, productId, env) };
}

async function loadEndpoint(c: C, productEnvId: string): Promise<EndpointRow> {
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM webhook_endpoints WHERE id = ? AND product_env_id = ?`)
    .bind(c.req.param('webhookId'), productEnvId).first<EndpointRow>();
  if (!row) throw new ApiError('not_found', 'Webhook endpoint not found');
  return row;
}

function checkUrl(url: string, env: Environment) {
  const problem = checkWebhookUrl(url, env);
  if (problem) {
    throw new ApiError('validation_failed', 'Webhook URL is not allowed', {
      issues: [{ path: 'url', message: problem }], reason: problem,
    });
  }
}

webhookRoutes.get(BASE, async (c) => {
  const s = await scope(c, 'webhooks:read');
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM webhook_endpoints WHERE product_env_id = ? ORDER BY created_at, id`)
    .bind(s.productEnvId).all<EndpointRow>();
  return c.json({ webhooks: results.map((r) => toEndpoint(r, s.productId, s.env)) });
});

webhookRoutes.post(BASE, async (c) => {
  const s = await scope(c, 'webhooks:manage');
  const body = await readJson(c, CreateWebhookRequest);
  checkUrl(body.url, s.env);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE product_env_id = ?').bind(s.productEnvId).first<{ n: number }>();
  if ((count?.n ?? 0) >= WEBHOOK_MAX_ENDPOINTS_PER_ENV) {
    throw new ApiError('quota_exceeded', `At most ${WEBHOOK_MAX_ENDPOINTS_PER_ENV} webhook endpoints per environment`);
  }
  const id = newId('whe');
  const secret = newWebhookSecret();
  const now = Date.now();
  const types = [...new Set(body.event_types)];
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO webhook_endpoints (id, product_env_id, url, description, event_types, enabled, secret, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.productEnvId, body.url, body.description ?? null, JSON.stringify(types), body.enabled ? 1 : 0, secret, c.get('admin').userId, now, now),
    adminAudit(c, {
      action: 'webhook.create', productId: s.productId, env: s.env, targetType: 'webhook_endpoint', targetId: id,
      metadata: { url: body.url, event_types: types, enabled: body.enabled },
    }),
  ]);
  const row = await loadEndpointById(c, id);
  // The signing secret is returned here and on rotation only.
  return c.json({ ...toEndpoint(row, s.productId, s.env), secret }, 201);
});

const loadEndpointById = (c: C, id: string) =>
  c.env.DB.prepare(`SELECT ${COLS} FROM webhook_endpoints WHERE id = ?`).bind(id).first<EndpointRow>() as Promise<EndpointRow>;

webhookRoutes.patch(`${BASE}/:webhookId`, async (c) => {
  const s = await scope(c, 'webhooks:manage');
  const body = await readJson(c, UpdateWebhookRequest);
  const row = await loadEndpoint(c, s.productEnvId);
  if (body.url !== undefined) checkUrl(body.url, s.env);
  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const binds: unknown[] = [now];
  if (body.url !== undefined) (sets.push('url = ?'), binds.push(body.url));
  if (body.description !== undefined) (sets.push('description = ?'), binds.push(body.description));
  if (body.event_types !== undefined) (sets.push('event_types = ?'), binds.push(JSON.stringify([...new Set(body.event_types)])));
  if (body.enabled !== undefined) (sets.push('enabled = ?'), binds.push(body.enabled ? 1 : 0));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, row.id),
    // Disabling cancels what is still queued for this endpoint (PRD §21.6).
    ...(body.enabled === false
      ? [c.env.DB.prepare(`UPDATE webhook_deliveries SET status = 'cancelled' WHERE endpoint_id = ? AND status = 'pending'`).bind(row.id)]
      : []),
    adminAudit(c, {
      action: 'webhook.update', productId: s.productId, env: s.env, targetType: 'webhook_endpoint', targetId: row.id,
      metadata: { changes: Object.keys(body) },
    }),
  ]);
  return c.json(toEndpoint(await loadEndpointById(c, row.id), s.productId, s.env));
});

webhookRoutes.delete(`${BASE}/:webhookId`, async (c) => {
  const s = await scope(c, 'webhooks:manage');
  const row = await loadEndpoint(c, s.productEnvId);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM webhook_attempts WHERE endpoint_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM webhook_endpoints WHERE id = ?').bind(row.id),
    adminAudit(c, { action: 'webhook.delete', productId: s.productId, env: s.env, targetType: 'webhook_endpoint', targetId: row.id, metadata: { url: row.url } }),
  ]);
  return c.body(null, 204);
});

/** New secret, shown once; the previous one keeps signing (second signature) for the grace period. */
webhookRoutes.post(`${BASE}/:webhookId/rotate-secret`, async (c) => {
  const s = await scope(c, 'webhooks:manage');
  const row = await loadEndpoint(c, s.productEnvId);
  const secret = newWebhookSecret();
  const now = Date.now();
  const graceUntil = now + WEBHOOK_SECRET_GRACE_S * 1000;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE webhook_endpoints SET previous_secret = secret, previous_secret_expires_at = ?, secret = ?, updated_at = ? WHERE id = ?')
      .bind(graceUntil, secret, now, row.id),
    adminAudit(c, {
      action: 'webhook.rotate_secret', productId: s.productId, env: s.env, targetType: 'webhook_endpoint', targetId: row.id,
      metadata: { previous_secret_expires_at: new Date(graceUntil).toISOString() },
    }),
  ]);
  return c.json({ id: row.id, secret, previous_secret_expires_at: graceUntil });
});

/** Send a `webhook.test` event to this endpoint now, once (no retries); the attempt is in the log. */
webhookRoutes.post(`${BASE}/:webhookId/test`, async (c) => {
  const s = await scope(c, 'webhooks:manage');
  const row = await loadEndpoint(c, s.productEnvId);
  if (!row.enabled) throw new ApiError('conflict', 'Enable the endpoint before sending a test event');
  const t = testMessageStatements({ productEnvId: s.productEnvId, productId: s.productId, env: s.env }, row.id);
  await c.env.DB.batch([
    ...prepareAll(c.env.DB, t.statements),
    adminAudit(c, { action: 'webhook.test', productId: s.productId, env: s.env, targetType: 'webhook_endpoint', targetId: row.id, metadata: { message_id: t.messageId } }),
  ]);
  const [result] = await deliverMessages(c.env.DB, [t.messageId], { fetch: webhookFetch() });
  return c.json({ message_id: t.messageId, attempt: result?.attempt ?? null });
});

const DeliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT).default(50) });

/** The endpoint's most recent attempts (status, latency, error, response snippet) and the queue size. */
webhookRoutes.get(`${BASE}/:webhookId/deliveries`, async (c) => {
  const s = await scope(c, 'webhooks:read');
  const q = readQuery(c, DeliveriesQuery);
  const row = await loadEndpoint(c, s.productEnvId);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.message_id, a.event_type, a.attempt, a.attempted_at, a.status_code, a.latency_ms, a.error, a.response_snippet,
            d.status AS delivery_status
     FROM webhook_attempts a LEFT JOIN webhook_deliveries d ON d.message_id = a.message_id AND d.endpoint_id = a.endpoint_id
     WHERE a.endpoint_id = ? ORDER BY a.attempted_at DESC, a.id DESC LIMIT ?`,
  ).bind(row.id, q.limit).all();
  const pending = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND status = 'pending'`)
    .bind(row.id).first<{ n: number }>();
  return c.json({ attempts: results, pending: pending?.n ?? 0 });
});
