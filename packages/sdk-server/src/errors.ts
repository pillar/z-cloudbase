import type { ErrorBody } from '@z-cloudbase/contracts';

/**
 * Every failure the SDK surfaces. `code` is a platform ErrorCode for API errors (PRD §19.5), an
 * OAuth error string for OIDC endpoint errors, or one of `network_error` / `timeout` / `sdk_error`.
 */
export class PlatformError extends Error {
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    opts: { status?: number; requestId?: string; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
    if (opts.details !== undefined) this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Build an error from a non-2xx API response; trusts the body's `retryable` flag when present. */
export function errorFromResponse(res: Response, bodyText: string): PlatformError {
  const headerId = res.headers.get('x-request-id') ?? undefined;
  try {
    const e = (JSON.parse(bodyText) as Partial<ErrorBody>).error;
    if (e && typeof e.code === 'string') {
      const requestId = e.request_id ?? headerId;
      return new PlatformError(e.code, e.message ?? res.statusText, {
        status: res.status,
        ...(requestId ? { requestId } : {}),
        retryable: e.retryable === true,
        ...(e.details ? { details: e.details } : {}),
      });
    }
  } catch {
    // not the unified body (e.g. a proxy error page): fall through
  }
  return new PlatformError(res.status >= 500 ? 'unavailable' : 'invalid_request', `HTTP ${res.status}`, {
    status: res.status,
    ...(headerId ? { requestId: headerId } : {}),
    retryable: RETRYABLE_STATUS.has(res.status),
  });
}
