import {
  ANALYTICS_RETENTION_DAYS_DEFAULT, ANALYTICS_RETENTION_DAYS_MAX, ARCHIVE_RETENTION_DAYS_DEFAULT, ARCHIVE_RETENTION_DAYS_MAX, boundedDays,
} from '@z-cloudbase/contracts';
import { archiveDayPrefix } from './events.ts';

const DAY_MS = 24 * 3600 * 1000;

export const analyticsRetentionDays = (env: Env) =>
  boundedDays((env as { ANALYTICS_RETENTION_DAYS?: unknown }).ANALYTICS_RETENTION_DAYS, ANALYTICS_RETENTION_DAYS_DEFAULT, ANALYTICS_RETENTION_DAYS_MAX);
export const archiveRetentionDays = (env: Env) =>
  boundedDays((env as { ARCHIVE_RETENTION_DAYS?: unknown }).ARCHIVE_RETENTION_DAYS, ARCHIVE_RETENTION_DAYS_DEFAULT, ARCHIVE_RETENTION_DAYS_MAX);

/**
 * Daily (PRD §21.8): drop analytics rows older than ANALYTICS_RETENTION_DAYS — event rows by occurrence,
 * actor days by day, actors whose last activity is older — and archive suppressions older than the archive
 * retention (no archived partition can still hold those users' events).
 */
export async function pruneAnalytics(env: Env, now = Date.now()): Promise<void> {
  const cutoffDay = Math.floor(now / DAY_MS) - analyticsRetentionDays(env);
  await env.INGEST_DB.batch([
    env.INGEST_DB.prepare('DELETE FROM event_rows WHERE occurred_at < ?').bind(cutoffDay * DAY_MS),
    env.INGEST_DB.prepare('DELETE FROM actor_daily WHERE day < ?').bind(cutoffDay),
    env.INGEST_DB.prepare('DELETE FROM actors WHERE last_day < ?').bind(cutoffDay),
    env.INGEST_DB.prepare('DELETE FROM archive_suppressions WHERE created_at < ?').bind(now - archiveRetentionDays(env) * DAY_MS),
  ]);
}

/** Days before the archive cutoff checked on each run, so missed runs catch up (PRD §21.9). */
const EXPIRY_LOOKBACK_DAYS = 7;
const LIST_LIMIT = 1000;

/**
 * Daily (PRD §21.9): delete `events/v2/` date partitions older than ARCHIVE_RETENTION_DAYS, at most
 * EXPIRY_LOOKBACK_DAYS dates and 1,000 objects per date per run (the rest goes next run). Returns objects deleted.
 */
export async function expireArchive(env: Env, now = Date.now()): Promise<number> {
  const cutoffDay = Math.floor(now / DAY_MS) - archiveRetentionDays(env);
  let deleted = 0;
  for (let day = cutoffDay - EXPIRY_LOOKBACK_DAYS; day < cutoffDay; day++) {
    const page = await env.ARCHIVE.list({ prefix: archiveDayPrefix(day), limit: LIST_LIMIT });
    if (page.objects.length === 0) continue;
    await env.ARCHIVE.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
  }
  return deleted;
}
