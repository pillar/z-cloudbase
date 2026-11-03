// Unified error format — PRD §19.5. OIDC endpoints do NOT use this format.

export const ERROR_STATUS = {
  invalid_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  token_expired: 401,
  invalid_token: 401,
  forbidden: 403,
  forbidden_product: 403,
  product_disabled: 403,
  membership_required: 403,
  /** The user is banned platform-wide (PRD §21.5.1); access tokens issued before the ban stop working. */
  user_banned: 403,
  /** A support impersonation token (`act` claim) on an action reserved for the user (PRD §21.5.2). */
  impersonation_restricted: 403,
  not_found: 404,
  identity_conflict: 409,
  idempotency_conflict: 409,
  /** Generic duplicate / state conflict (e.g. an admin creating something that already exists). */
  conflict: 409,
  payload_too_large: 413,
  quota_exceeded: 422,
  unsupported_type: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limited', 'unavailable']);

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    opts?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
    this.retryable = opts?.retryable ?? RETRYABLE.has(code);
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
