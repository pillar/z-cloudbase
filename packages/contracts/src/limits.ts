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
