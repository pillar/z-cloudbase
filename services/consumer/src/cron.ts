import { ANALYTICS_QUERY_WINDOW_DAYS, ANONYMOUS_USER_RETENTION_DAYS, UPLOAD_URL_TTL_S, newId, parseClientId } from '@z-cloudbase/contracts';
import { systemAudit } from './audit.ts';

const DAY_MS = 24 * 3600 * 1000;

/** Daily cron expression in wrangler.jsonc; every other trigger is the 15-minute one. */
export const DAILY_CRON = '0 3 * * *';

/**
 * Every 15 minutes: drop expired dedupe claims (PRD §19.6), idempotency keys (PRD §19.5), finished auth rate
 * windows and expired one-time export links (PRD §19.8; downloads are in the audit log, used links serve nothing).
 */
export async function purgeExpired(env: Env, now = Date.now()): Promise<void> {
  await env.INGEST_DB.prepare('DELETE FROM event_dedup WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').bind(now).run();
  // One-minute windows (identity rate-limit.ts); keep the previous one, which may still be counting.
  await env.DB.prepare('DELETE FROM auth_rate_counters WHERE window_start < ?').bind(now - 2 * 60_000).run();
  await env.DB.prepare('DELETE FROM export_links WHERE expires_at <= ?').bind(now).run();
}

/** A `pending` upload older than this can no longer be uploaded or completed (URL expired + 1 h margin). */
export const STALE_PENDING_UPLOAD_MS = UPLOAD_URL_TTL_S * 1000 + 3600 * 1000;
const REAP_PAGE = 40;

/**
 * Every 15 minutes: reclaim uploads that were created but never completed (PRD §4.3). They still
 * count against the product quota, and bytes may have reached R2 without a `complete` call. Deletes
 * the R2 object if present (deleting a missing key is a no-op), then the row, each with a system
 * audit row. Returns the number of reaped uploads.
 */
export async function reapStalePendingUploads(env: Env, now = Date.now(), maxPages = 25): Promise<number> {
  let reaped = 0;
  for (let page = 0; page < maxPages; page++) {
    // Claim first: once the row is no longer `pending`, a racing `complete` cannot make it available
    // (its UPDATE is conditional on `pending`), so deleting the bytes below never orphans a live row.
    const { results } = await env.DB.prepare(
      `UPDATE storage_objects SET status = 'deleted', deleted_at = ?, deleted_by = 'system'
       WHERE id IN (SELECT id FROM storage_objects WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ${REAP_PAGE})
         AND status = 'pending'
       RETURNING id, object_key, bucket, size, owner_user_id, created_at, product_env_id`,
    ).bind(now, now - STALE_PENDING_UPLOAD_MS).all<{
      id: string; object_key: string; bucket: string; size: number; owner_user_id: string | null; created_at: number; product_env_id: string;
    }>();
    if (results.length === 0) break;
    await env.STORAGE.delete(results.map((o) => o.object_key));
    await env.DB.batch(results.flatMap((o) => {
      const parsed = parseClientId(o.product_env_id);
      return [
        env.DB.prepare(`DELETE FROM storage_objects WHERE id = ?`).bind(o.id),
        systemAudit(env.DB, {
          action: 'storage.pending_upload.reaped', productId: parsed?.productId ?? null, env: parsed?.env ?? null, targetType: 'storage_object', targetId: o.id,
          metadata: { bucket: o.bucket, size: o.size, owner_user_id: o.owner_user_id, created_at: new Date(o.created_at).toISOString() },
        }),
      ];
    }));
    reaped += results.length;
    if (results.length < REAP_PAGE) break;
  }
  return reaped;
}

/** Daily: events older than the query window are no longer readable, so the D1 substitute drops them. */
export async function pruneSubstitute(env: Env, now = Date.now()): Promise<void> {
  await env.INGEST_DB.prepare('DELETE FROM events_substitute WHERE occurred_at < ?').bind(now - ANALYTICS_QUERY_WINDOW_DAYS * DAY_MS).run();
}

/**
 * Daily: anonymous users that never linked a credential and have been inactive for the retention
 * period enter the account-deletion flow, due immediately (PRD §19.7). Reads the auth engine tables
 * read-only. Linking any credential clears `isAnonymous` (identity auth hooks), and an existing
 * `account` row also disqualifies. Activity is the latest of identity sign-in (`lastActiveAt`) and
 * product token refreshes (`product_memberships.last_seen_at`), since an anonymous user keeps using
 * products through refresh tokens without new identity sessions. Returns the number created.
 */
export async function reclaimAnonymous(env: Env, now = Date.now()): Promise<number> {
  const cutoffMs = now - ANONYMOUS_USER_RETENTION_DAYS * DAY_MS;
  const cutoff = new Date(cutoffMs).toISOString();
  // `typeof ... = 'text'` guards the ISO-string comparison against any non-text date representation.
  const { results } = await env.DB.prepare(
    `SELECT u.id FROM "user" u
     WHERE u.isAnonymous = 1 AND u.deletedAt IS NULL
       AND typeof(COALESCE(u.lastActiveAt, u.createdAt)) = 'text' AND COALESCE(u.lastActiveAt, u.createdAt) < ?
       AND NOT EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id)
       AND NOT EXISTS (SELECT 1 FROM product_memberships pm WHERE pm.user_id = u.id AND pm.last_seen_at >= ?)
       AND NOT EXISTS (SELECT 1 FROM deletion_requests d WHERE d.user_id = u.id AND d.kind = 'delete' AND d.scope = 'account' AND d.status IN ('pending','processing'))
     LIMIT 500`,
  ).bind(cutoff, cutoffMs).all<{ id: string }>();
  for (let i = 0; i < results.length; i += 40) {
    await env.DB.batch(results.slice(i, i + 40).flatMap(({ id }) => {
      const requestId = newId('del');
      return [
        env.DB.prepare(
          `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, 'delete', 'account', NULL, 'pending', ?, ?)`,
        ).bind(requestId, id, now, now),
        systemAudit(env.DB, { action: 'anonymous.reclaim_requested', targetType: 'user', targetId: id, metadata: { deletion_request_id: requestId } }),
      ];
    }));
  }
  return results.length;
}
