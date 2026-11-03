// Webhook outbox (PRD §21.6): statements that record an event for a product environment, to be run in
// the same D1 batch as the domain change that caused it. Statements are returned as SQL + binds so the
// caller prepares them on its own D1 binding (workers do not share D1 types with this package).
import {
  WEBHOOK_MAX_ATTEMPTS, newId, type Environment, type WebhookEventData, type WebhookEventType,
} from '@z-cloudbase/contracts';
import type { Db } from './db.ts';

export interface SqlStatement {
  sql: string;
  binds: unknown[];
}

export interface ProductEnvTarget {
  productEnvId: string;
  productId: string;
  env: Environment;
}

/** `EXISTS` clause: an enabled endpoint of `?` (product env) subscribed to `?` (event type). */
const SUBSCRIBED = `EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.product_env_id = ? AND e.enabled = 1
  AND EXISTS (SELECT 1 FROM json_each(e.event_types) j WHERE j.value = ?))`;

export interface OutboxEvent<T extends WebhookEventType> {
  target: ProductEnvTarget;
  type: T;
  data: WebhookEventData<T>;
  now?: number;
  /** Extra SQL condition (with binds) the message insert must also satisfy, e.g. "this batch created the row". */
  condition?: SqlStatement;
}

/**
 * Message + deliveries for one product environment. Nothing is written when no enabled endpoint of that
 * environment subscribes to the type (or the condition is false). The payload is fixed here: it is the
 * exact body that every attempt signs and sends.
 */
export function outboxStatements<T extends WebhookEventType>(e: OutboxEvent<T>): { messageId: string; statements: SqlStatement[] } {
  const now = e.now ?? Date.now();
  const messageId = newId('msg');
  const payload = JSON.stringify({
    id: messageId,
    type: e.type,
    timestamp: new Date(now).toISOString(),
    product_id: e.target.productId,
    env: e.target.env,
    data: e.data,
  });
  const cond = e.condition ? ` AND (${e.condition.sql})` : '';
  return {
    messageId,
    statements: [
      {
        sql: `INSERT INTO webhook_messages (id, product_env_id, event_type, payload, created_at)
              SELECT ?, ?, ?, ?, ? WHERE ${SUBSCRIBED}${cond}`,
        binds: [messageId, e.target.productEnvId, e.type, payload, now, e.target.productEnvId, e.type, ...(e.condition?.binds ?? [])],
      },
      {
        sql: `INSERT INTO webhook_deliveries (message_id, endpoint_id, status, attempts, max_attempts, next_attempt_at, created_at)
              SELECT m.id, e.id, 'pending', 0, ?, m.created_at, m.created_at
              FROM webhook_messages m JOIN webhook_endpoints e ON e.product_env_id = m.product_env_id
              WHERE m.id = ? AND e.enabled = 1 AND EXISTS (SELECT 1 FROM json_each(e.event_types) j WHERE j.value = m.event_type)`,
        binds: [WEBHOOK_MAX_ATTEMPTS, messageId],
      },
    ],
  };
}

/**
 * Product environments where `userId` has signed in (product_env_users) and an enabled endpoint subscribes
 * to `type`; optionally only within one product. Used to fan out user-scoped events (PRD §21.6).
 */
export async function userEventTargets(db: Db, userId: string, type: WebhookEventType, productId?: string): Promise<ProductEnvTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT pe.id AS product_env_id, pe.product_id, pe.env FROM product_env_users u
       JOIN product_environments pe ON pe.id = u.product_env_id
       WHERE u.user_id = ?${productId ? ' AND pe.product_id = ?' : ''}
         AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.product_env_id = pe.id AND e.enabled = 1
           AND EXISTS (SELECT 1 FROM json_each(e.event_types) j WHERE j.value = ?))
       ORDER BY pe.id`,
    )
    .bind(...(productId ? [userId, productId, type] : [userId, type]))
    .all<{ product_env_id: string; product_id: string; env: Environment }>();
  return results.map((r) => ({ productEnvId: r.product_env_id, productId: r.product_id, env: r.env }));
}

/** One event for each target; returns the message ids (for the immediate delivery) and all statements. */
export function fanOutStatements<T extends WebhookEventType>(
  targets: ProductEnvTarget[],
  type: T,
  data: WebhookEventData<T>,
  now = Date.now(),
): { messageIds: string[]; statements: SqlStatement[] } {
  const out = targets.map((target) => outboxStatements({ target, type, data, now }));
  return { messageIds: out.map((o) => o.messageId), statements: out.flatMap((o) => o.statements) };
}
