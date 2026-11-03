// Initial default limits — PRD §19.4 / §19.6. Change the PRD first, then these.

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
export const IDENTITY_SESSION_TTL_S = 7 * 24 * 3600;
export const REAUTH_WINDOW_S = 5 * 60;
export const JWT_CLOCK_TOLERANCE_S = 30;
export const PRODUCT_STATUS_CACHE_S = 60;

export const EVENTS_MAX_PER_BATCH = 100;
export const EVENTS_MAX_BATCH_BYTES = 256 * 1024;
export const EVENT_MAX_PROPERTIES_BYTES = 8 * 1024;
export const EVENT_MAX_PROPERTIES_KEYS = 50;
export const EVENT_MAX_PAST_MS = 7 * 24 * 3600 * 1000;
export const EVENT_MAX_FUTURE_MS = 5 * 60 * 1000;
export const EVENT_DEDUP_WINDOW_S = 24 * 3600;

export const LOGS_MAX_PER_BATCH = 100;
export const LOGS_MAX_BATCH_BYTES = 512 * 1024;
export const LOG_MAX_ENTRY_BYTES = 16 * 1024;
export const LOG_MAX_ATTRIBUTE_KEYS = 30;
export const BROWSER_ERROR_MAX_BYTES = 8 * 1024;

export const SENSITIVE_KEY_RE = /password|secret|token|authorization|cookie|api_key/i;
export const REDACTED = '[REDACTED]';

export const UPLOAD_URL_TTL_S = 10 * 60;
export const DOWNLOAD_URL_TTL_DEFAULT_S = 5 * 60;
export const DOWNLOAD_URL_TTL_MAX_S = 60 * 60;
export const DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PRODUCT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

export const AUTH_RATE_PER_IP_PER_MIN = 10;
export const AUTH_RATE_PER_ACCOUNT_PER_MIN = 5;
export const INGEST_BATCHES_PER_KEY_PER_MIN = 600;

export const IDEMPOTENCY_KEY_TTL_S = 24 * 3600;
export const ANONYMOUS_USER_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_COOLDOWN_DAYS = 7;
export const ANALYTICS_QUERY_WINDOW_DAYS = 90;

// v2.2 additions (PRD §19.6, §19.8, §19.9).
/** Failed sign-in / reset attempts (per account or per IP) within the window before Turnstile is required. */
export const TURNSTILE_AFTER_FAILURES = 3;
export const AUTH_FAILURE_WINDOW_S = 15 * 60;
/** Default per-product-environment daily upload volume (UTC day, bytes of created uploads). */
export const DEFAULT_DAILY_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** One-time export download link lifetime. */
export const EXPORT_LINK_TTL_S = 15 * 60;

// v3.1 analytics (PRD §19.6, §21.7–21.9).
/** Events packed into one queue message; with the consumer's max_batch_size 10 this keeps ≤ 250 AE data points per invocation. */
export const EVENTS_PER_QUEUE_MESSAGE = 25;
/** Queue messages are capped at 128 KB; stay well below. */
export const EVENTS_QUEUE_MESSAGE_MAX_BYTES = 100 * 1024;
/** Properties JSON kept in `event_rows` (explorer); larger ones are only in the archive. */
export const EVENT_ROW_PROPERTIES_MAX_BYTES = 1024;
export const USER_PROPERTIES_MAX_KEYS = 20;
export const USER_PROPERTIES_MAX_BYTES = 2048;
export const USER_PROPERTY_VALUE_MAX_CHARS = 256;
export const USER_PROPERTY_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
/** Default / bounds of ANALYTICS_RETENTION_DAYS (event_rows, actor tables, query window). */
export const ANALYTICS_RETENTION_DAYS_DEFAULT = 90;
export const ANALYTICS_RETENTION_DAYS_MAX = 90;
/** Default / bounds of ARCHIVE_RETENTION_DAYS (R2 raw event archive). */
export const ARCHIVE_RETENTION_DAYS_DEFAULT = 90;
export const ARCHIVE_RETENTION_DAYS_MAX = 3650;
export const ANALYTICS_CUSTOM_DIMENSIONS_MAX = 3;
export const FUNNEL_MIN_STEPS = 2;
export const FUNNEL_MAX_STEPS = 5;
export const FUNNEL_DEFAULT_WINDOW_S = 24 * 3600;
export const FUNNEL_MAX_WINDOW_S = 30 * 24 * 3600;
export const RETENTION_MAX_PERIODS = { day: 31, week: 13 } as const;
export const BREAKDOWN_MAX_ROWS = 50;
export const EXPLORER_MAX_PAGE = 100;
export const EXPORT_MAX_DAYS = 31;
export const EXPORT_MAX_OBJECTS = 2000;
/** Web SDK `js_error` autocapture: reports per page load. */
export const WEB_ERRORS_PER_PAGE = 10;

/** A day-count deployment variable within [1, max]; anything unparsable falls back to the default. */
export function boundedDays(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}
