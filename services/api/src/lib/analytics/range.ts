import {
  ANALYTICS_RETENTION_DAYS_DEFAULT, ANALYTICS_RETENTION_DAYS_MAX, ARCHIVE_RETENTION_DAYS_DEFAULT, ARCHIVE_RETENTION_DAYS_MAX, ApiError, boundedDays,
} from '@z-cloudbase/contracts';

export const DAY_MS = 24 * 3600 * 1000;
export const dayNumber = (ms: number) => Math.floor(ms / DAY_MS);
export const dayString = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export const analyticsRetentionDays = (env: object) =>
  boundedDays((env as { ANALYTICS_RETENTION_DAYS?: unknown }).ANALYTICS_RETENTION_DAYS, ANALYTICS_RETENTION_DAYS_DEFAULT, ANALYTICS_RETENTION_DAYS_MAX);
export const archiveRetentionDays = (env: object) =>
  boundedDays((env as { ARCHIVE_RETENTION_DAYS?: unknown }).ARCHIVE_RETENTION_DAYS, ARCHIVE_RETENTION_DAYS_DEFAULT, ARCHIVE_RETENTION_DAYS_MAX);

/** UTC day range [fromDay, toDay) from ISO dates; defaults to the last `defaultDays` days, clamped to `retentionDays`. */
export function dayRange(q: { from?: string | undefined; to?: string | undefined }, retentionDays: number, now = Date.now(), defaultDays = 7) {
  const today = dayNumber(now);
  const toDay = q.to ? dayNumber(Date.parse(`${q.to}T00:00:00Z`)) : today + 1;
  let fromDay = q.from ? dayNumber(Date.parse(`${q.from}T00:00:00Z`)) : toDay - defaultDays;
  if (Number.isNaN(fromDay) || Number.isNaN(toDay)) throw new ApiError('validation_failed', 'from/to must be dates (YYYY-MM-DD)');
  fromDay = Math.max(fromDay, today + 1 - retentionDays);
  if (fromDay >= toDay) throw new ApiError('validation_failed', 'from must be before to, within the retention window');
  return { fromDay, toDay, from: dayString(fromDay), to: dayString(toDay) };
}
