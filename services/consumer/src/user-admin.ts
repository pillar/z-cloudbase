// Consumer side of PRD §21.5 / §21.6, run on the existing cron schedules (no new triggers): webhook retries
// and housekeeping, expired bans (audit + `user.unbanned`), and impersonations past their lifetime.
import { deliverDue, deliverMessages, fanOutStatements, pruneWebhookData, userEventTargets, type Fetcher, type SqlStatement } from '@z-cloudbase/webhooks';
import { systemAudit } from './audit.ts';

let fetcher: Fetcher | undefined;
/** Tests only: replace the outbound fetch used for webhook deliveries (null restores the global fetch). */
export function setWebhookFetch(f: Fetcher | null): void {
  fetcher = f ?? undefined;
}
export const webhookFetch = (): Fetcher | undefined => fetcher;

export const prepareAll = (db: D1Database, statements: SqlStatement[]) => statements.map((s) => db.prepare(s.sql).bind(...s.binds));

/** First attempt of events this worker just recorded (deletion completed, ban expired). */
export const deliverNow = (env: Env, messageIds: string[]) => deliverMessages(env.DB, messageIds, { fetch: fetcher });

/** Every 15 minutes: due webhook retries (and first attempts an emitter never got to). */
export const retryWebhooks = (env: Env, now = Date.now()) => deliverDue(env.DB, { fetch: fetcher, now: () => now });

/** Daily: webhook messages / deliveries past retention, attempt log beyond the per-endpoint cap, old rotation secrets. */
export const pruneWebhooks = (env: Env, now = Date.now()) => pruneWebhookData(env.DB, now);

/**
 * Every 15 minutes: lift bans whose end has passed (they already stopped applying at that moment; this
 * records it): a system audit `user.unban` and the `user.unbanned` event with reason `expired`.
 */
export async function expireBans(env: Env, now = Date.now()): Promise<number> {
  const nowIso = new Date(now).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM "user" WHERE banned = 1 AND banExpires IS NOT NULL AND typeof(banExpires) = 'text' AND banExpires <= ? LIMIT 100`,
  ).bind(nowIso).all<{ id: string }>();
  const messageIds: string[] = [];
  for (const { id } of results) {
    const fan = fanOutStatements(await userEventTargets(env.DB, id, 'user.unbanned'), 'user.unbanned', { user_id: id, reason: 'expired' }, now);
    await env.DB.batch([
      env.DB.prepare('UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL, updatedAt = ? WHERE id = ? AND banned = 1').bind(nowIso, id),
      systemAudit(env.DB, { action: 'user.unban', targetType: 'user', targetId: id, metadata: { reason: 'expired' } }),
      ...prepareAll(env.DB, fan.statements),
    ]);
    messageIds.push(...fan.messageIds);
  }
  await deliverNow(env, messageIds);
  return results.length;
}

/**
 * Every 15 minutes: impersonations past their fixed lifetime end (`expired`); their sessions are deleted,
 * which removes the product tokens issued during them (migration 0018 trigger). Unconfirmed requests past
 * their window are cancelled.
 */
export async function expireImpersonations(env: Env, now = Date.now()): Promise<number> {
  await env.DB.prepare(`UPDATE impersonations SET status = 'cancelled', ended_at = ?, end_reason = 'request_expired' WHERE status = 'pending' AND request_expires_at <= ?`)
    .bind(now, now).run();
  const { results } = await env.DB.prepare(
    `UPDATE impersonations SET status = 'ended', ended_at = ?, end_reason = 'expired' WHERE status = 'active' AND expires_at <= ?
     RETURNING id, actor_id, target_id, session_id`,
  ).bind(now, now).all<{ id: string; actor_id: string; target_id: string; session_id: string | null }>();
  if (results.length === 0) return 0;
  await env.DB.batch(results.flatMap((r) => [
    ...(r.session_id ? [env.DB.prepare('DELETE FROM "session" WHERE id = ?').bind(r.session_id)] : []),
    systemAudit(env.DB, {
      action: 'user.impersonation.stop', targetType: 'user', targetId: r.target_id,
      metadata: { impersonation_id: r.id, actor_id: r.actor_id, end_reason: 'expired' },
    }),
  ]));
  return results.length;
}
