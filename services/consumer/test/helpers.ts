// Fixtures for consumer tests: queue batches shaped like the api's messages, seeded platform rows.
import { newId, type EventInput, type EventQueueMessage, type LogQueueMessage } from '@z-cloudbase/contracts';
import { createMessageBatch, createExecutionContext, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import worker from '../src/index.ts';

export type TestEnv = typeof baseEnv;

/** Deliver `bodies` to the consumer's queue handler and report which messages were acked / retried. */
export async function deliver(queue: string, bodies: unknown[], env: TestEnv | Record<string, unknown> = baseEnv, attempts = 1) {
  const batch = createMessageBatch(queue, bodies.map((body, i) => ({ id: `${queue}-${newId('m')}-${i}`, timestamp: new Date(), attempts, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env as TestEnv, ctx);
  await waitOnExecutionContext(ctx);
  const r = await getQueueResult(batch, ctx);
  return { acked: r.explicitAcks, retried: r.retryMessages.map((m) => m.msgId), retryAll: r.retryBatch.retry };
}

/** Same messages (same ids) redelivered, as the queue does after a retry. */
export function fixedBatch(queue: string, items: Array<{ id: string; body: unknown }>) {
  return createMessageBatch(queue, items.map(({ id, body }) => ({ id, timestamp: new Date(), attempts: 2, body })));
}

export const now = () => new Date().toISOString();

export function logMessage(product: string, env: string, over: Partial<LogQueueMessage['entry']> & { ingest?: string; source?: 'server' | 'browser'; received?: string } = {}): LogQueueMessage {
  const { ingest, source, received, ...entry } = over;
  return {
    product_id: product, environment: env, source: source ?? 'server', received_at: received ?? now(), ingest_request_id: ingest ?? newId('req'),
    entry: { level: 'info', timestamp: now(), message: 'hello', attributes: {}, ...entry },
  };
}

export function eventMessage(product: string, env: string, over: Partial<EventInput> & { user_key?: string | null; received?: string } = {}): EventQueueMessage {
  const { user_key, received, ...event } = over;
  return {
    product_id: product, environment: env, user_key: user_key ?? null, received_at: received ?? now(),
    event: { event_id: crypto.randomUUID(), event_name: 'page_view', occurred_at: now(), properties: {}, schema_version: 1, ...event },
  };
}

/** Analytics Engine stand-in recording data points. */
export function fakeAe() {
  const points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
  return { points, writeDataPoint: (p: (typeof points)[number]) => void points.push(p) };
}

export async function seedProduct(db: D1Database, productId: string, envName = 'prod') {
  const now = Date.now();
  await db.prepare(`INSERT OR IGNORE INTO products (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).bind(productId, productId, now, now).run();
  await db.prepare(
    `INSERT INTO product_environments (id, product_id, env, publishable_key, user_key_salt, storage_quota_bytes, max_object_bytes, created_at) VALUES (?, ?, ?, ?, 'salt', 1, 1, ?)`,
  ).bind(`${productId}.${envName}`, productId, envName, `pk_${envName}_${productId}_${newId('k')}`, now).run();
}

export async function seedObject(env: TestEnv, o: { userId: string | null; productEnvId: string; bucket?: string; filename?: string }) {
  const id = newId('obj');
  const key = `${o.productEnvId}/${id}`;
  await env.STORAGE.put(key, 'content');
  await env.DB.prepare(
    `INSERT INTO storage_objects (id, product_env_id, bucket, owner_user_id, object_key, filename, content_type, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 7, 'available', ?)`,
  ).bind(id, o.productEnvId, o.bucket ?? 'files', o.userId, key, o.filename ?? 'f.txt', Date.now()).run();
  return { id, key };
}

export async function seedMembership(db: D1Database, userId: string, productId: string, opts: { status?: string; lastSeenAt?: number } = {}) {
  await db.prepare(`INSERT INTO product_memberships (user_id, product_id, status, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(userId, productId, opts.status ?? 'active', Date.now(), opts.lastSeenAt ?? null).run();
}

/** Row in the auth engine's `user` table; dates are ISO strings like the engine's D1 adapter writes them. */
export async function seedAuthUser(db: D1Database, u: { id: string; anonymous: boolean; lastActiveAt: string | null; createdAt?: string; deletedAt?: string | null }) {
  const created = u.createdAt ?? u.lastActiveAt ?? new Date().toISOString();
  await db.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous, lastActiveAt, deletedAt) VALUES (?, 'n', ?, 0, ?, ?, ?, ?, ?)`,
  ).bind(u.id, `${u.id}@x.test`, created, created, u.anonymous ? 1 : 0, u.lastActiveAt, u.deletedAt ?? null).run();
}

export async function seedAuthAccount(db: D1Database, userId: string) {
  const t = new Date().toISOString();
  await db.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?)`)
    .bind(newId('acc'), userId, userId, t, t).run();
}
