// Webhook delivery from the api worker (PRD §21.6): the console's test send. Events themselves are emitted
// by identity (sign-in, bans) and the consumer (deletion, ban expiry, retries).
import type { Fetcher, SqlStatement } from '@z-cloudbase/webhooks';

let fetcher: Fetcher | undefined;
/** Tests only: replace the outbound fetch used for webhook deliveries (null restores the global fetch). */
export function setWebhookFetch(f: Fetcher | null): void {
  fetcher = f ?? undefined;
}
export const webhookFetch = (): Fetcher | undefined => fetcher;

export const prepareAll = (db: D1Database, statements: SqlStatement[]) => statements.map((s) => db.prepare(s.sql).bind(...s.binds));
