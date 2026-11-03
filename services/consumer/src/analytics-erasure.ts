import { userKey } from '@z-cloudbase/security';
import { analyticsRetentionDays, archiveRetentionDays } from './analytics-retention.ts';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Erase a user's analytics in the given product scope (PRD §21.9 deletion): for every product environment
 * where the pseudonymous user_key has an actor row or user properties, delete event rows (located through
 * the actor's days, so only those days are scanned), actor rows and user properties, and record an archive
 * suppression so exports exclude the user from now on. When the archive outlives the analytics window, every
 * environment of the scope is suppressed (archived events may remain after the actor rows have expired).
 * Idempotent. Returns the product environments that held data.
 */
export async function eraseUserAnalytics(env: Env, userId: string, productId: string | null): Promise<string[]> {
  const { results: envs } = await env.DB.prepare(
    `SELECT id, user_key_salt FROM product_environments${productId ? ' WHERE product_id = ?' : ''}`,
  ).bind(...(productId ? [productId] : [])).all<{ id: string; user_key_salt: string }>();
  if (envs.length === 0) return [];
  const keys = await Promise.all(envs.map(async (e) => ({ p: e.id, k: await userKey(userId, e.user_key_salt) })));
  const { results: hits } = await env.INGEST_DB.prepare(
    `SELECT DISTINCT json_extract(j.value, '$.p') AS p FROM json_each(?) j
     WHERE EXISTS (SELECT 1 FROM actors a WHERE a.product_env_id = json_extract(j.value, '$.p') AND a.actor = json_extract(j.value, '$.k'))
        OR EXISTS (SELECT 1 FROM user_properties u WHERE u.product_env_id = json_extract(j.value, '$.p') AND u.user_key = json_extract(j.value, '$.k'))`,
  ).bind(JSON.stringify(keys)).all<{ p: string }>();
  const hit = new Set(hits.map((h) => h.p));
  const suppressAll = archiveRetentionDays(env) > analyticsRetentionDays(env);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const { p, k } of keys) {
    if (hit.has(p)) {
      stmts.push(
        env.INGEST_DB.prepare(
          `DELETE FROM event_rows WHERE product_env_id = ?1 AND event_id IN (
             SELECT e.event_id FROM (SELECT DISTINCT day FROM actor_daily WHERE product_env_id = ?1 AND actor = ?2) d
             JOIN event_rows e ON e.product_env_id = ?1 AND e.occurred_at >= d.day * ${DAY_MS} AND e.occurred_at < (d.day + 1) * ${DAY_MS}
             WHERE e.user_key = ?2)`,
        ).bind(p, k),
        env.INGEST_DB.prepare('DELETE FROM actor_daily WHERE product_env_id = ? AND actor = ?').bind(p, k),
        env.INGEST_DB.prepare('DELETE FROM actors WHERE product_env_id = ? AND actor = ?').bind(p, k),
        env.INGEST_DB.prepare('DELETE FROM user_properties WHERE product_env_id = ? AND user_key = ?').bind(p, k),
      );
    }
    if (hit.has(p) || suppressAll) {
      stmts.push(env.INGEST_DB.prepare('INSERT OR REPLACE INTO archive_suppressions (product_env_id, user_key, created_at) VALUES (?, ?, ?)').bind(p, k, now));
    }
  }
  // D1 batches are transactions; keep each well within the per-invocation query budget.
  for (let i = 0; i < stmts.length; i += 40) await env.INGEST_DB.batch(stmts.slice(i, i + 40));
  return [...hit];
}
