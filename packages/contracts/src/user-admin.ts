// Platform user management — PRD §21.5: ban / unban, impersonation, per-environment user export.
import { z } from 'zod';

export const BAN_REASON_MAX = 500;
/** A ban may end at most this far in the future (otherwise: permanent, no expiry). */
export const BAN_MAX_DURATION_DAYS = 3650;

export const BanUserRequest = z.object({
  reason: z.string().trim().min(1).max(BAN_REASON_MAX),
  /** Optional end of the ban (ISO 8601, future); absent = permanent. */
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
export type BanUserRequest = z.infer<typeof BanUserRequest>;

/** Ban state as shown to console callers (`reason` only for callers who may ban). */
export interface BanState {
  banned: boolean;
  expires_at: string | null;
  reason?: string | null;
}

export const IMPERSONATION_REASON_MIN = 10;
export const IMPERSONATION_REASON_MAX = 500;
/** Fixed lifetime of an impersonation session (never extended). */
export const IMPERSONATION_MAX_S = 60 * 60;
/** A requested impersonation must be confirmed on the identity domain within this window. */
export const IMPERSONATION_REQUEST_TTL_S = 10 * 60;
/** Wrong TOTP codes on the confirmation page before the request is cancelled (PRD §21.5.2). */
export const IMPERSONATION_MAX_CODE_ATTEMPTS = 5;

export const StartImpersonationRequest = z.object({
  reason: z.string().trim().min(IMPERSONATION_REASON_MIN).max(IMPERSONATION_REASON_MAX),
});
export type StartImpersonationRequest = z.infer<typeof StartImpersonationRequest>;

export const IMPERSONATION_END_REASONS = ['stopped', 'signed_out', 'expired', 'target_banned'] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

/** RFC 8693 actor claim on product tokens issued during an impersonation. */
export interface ActorClaim {
  sub: string;
}

export const USER_EXPORT_PAGE_ROWS = 5000;
export const USER_EXPORT_COLUMNS = [
  'user_id', 'is_anonymous', 'account_created_at', 'env_first_seen_at', 'membership_status', 'product_joined_at',
  'product_last_seen_at', 'providers', 'banned',
] as const;
