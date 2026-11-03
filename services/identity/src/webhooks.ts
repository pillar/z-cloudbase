// Webhook events emitted by the identity worker (PRD §21.6): `user.joined` (first authorization in a
// product environment) and `user.upgraded` (guest linked its first credential); ban events come from
// user-admin.ts. Outbox rows are written with the domain change; the first attempt runs in waitUntil.
import { clientId, type Environment } from '@z-cloudbase/contracts';
import {
  deliverMessages, fanOutStatements, outboxStatements, userEventTargets, type Fetcher, type SqlStatement,
} from '@z-cloudbase/webhooks';
import { waitUntil } from 'cloudflare:workers';

let fetcher: Fetcher | undefined;
/** Tests only: replace the outbound fetch used for webhook deliveries (null restores the global fetch). */
export function setWebhookFetch(f: Fetcher | null): void {
  fetcher = f ?? undefined;
}

export const prepareAll = (db: D1Database, statements: SqlStatement[]) => statements.map((s) => db.prepare(s.sql).bind(...s.binds));

/** First delivery attempt after the response (the consumer cron retries whatever this misses). */
export function deliverSoon(db: D1Database, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const work = deliverMessages(db, messageIds, { fetch: fetcher }).catch((e) =>
    console.error(JSON.stringify({ msg: 'webhook delivery failed', error: String(e) })),
  );
  try {
    waitUntil(work);
  } catch {
    // Outside a request context the promise simply runs on.
  }
}

/**
 * Statements recording the first authorization of `userId` in `{productId}.{env}`, to batch after the
 * membership statements: a `product_env_users` row (only with an active membership and an existing
 * environment row) and, when that row is new, the `user.joined` event.
 */
export function envJoinStatements(db: D1Database, o: { productId: string; env: Environment; userId: string; anonymous: boolean; now: number }) {
  const envId = clientId(o.productId, o.env);
  const joined = outboxStatements({
    target: { productEnvId: envId, productId: o.productId, env: o.env },
    type: 'user.joined',
    data: { user_id: o.userId, anonymous: o.anonymous, first_seen_at: new Date(o.now).toISOString() },
    now: o.now,
    // Only when this batch created the row (first_seen_at is this call's timestamp).
    condition: {
      sql: 'EXISTS (SELECT 1 FROM product_env_users WHERE product_env_id = ? AND user_id = ? AND first_seen_at = ?)',
      binds: [envId, o.userId, o.now],
    },
  });
  return {
    messageId: joined.messageId,
    statements: [
      db.prepare(
        `INSERT OR IGNORE INTO product_env_users (product_env_id, user_id, first_seen_at)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM product_environments WHERE id = ?)
           AND EXISTS (SELECT 1 FROM product_memberships WHERE user_id = ? AND product_id = ? AND status = 'active')`,
      ).bind(envId, o.userId, o.now, envId, o.userId, o.productId),
      ...prepareAll(db, joined.statements),
    ],
  };
}

/** `user.upgraded` to every product environment the user signed in to. */
export async function emitUpgraded(db: D1Database, userId: string, provider: string): Promise<void> {
  const targets = await userEventTargets(db, userId, 'user.upgraded');
  if (targets.length === 0) return;
  const { messageIds, statements } = fanOutStatements(targets, 'user.upgraded', { user_id: userId, provider });
  await db.batch(prepareAll(db, statements));
  deliverSoon(db, messageIds);
}
