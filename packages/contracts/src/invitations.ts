// Platform invitations (PRD §21.2): with SIGNUP_MODE=invite only an invitation link lets a new
// Email / Password account be created. Managed by platform owners through /v1/admin/invitations.
import { z } from 'zod';
import type { ErrorCode } from './errors.ts';

export const INVITATION_STATUSES = ['pending', 'used', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export const INVITATION_DELIVERIES = ['email', 'link'] as const;
export type InvitationDelivery = (typeof INVITATION_DELIVERIES)[number];

export const INVITATION_TTL_DAYS_DEFAULT = 7;
export const INVITATION_TTL_DAYS_MAX = 30;

export const CreateInvitationRequest = z.object({
  email: z.email().max(254),
  expires_in_days: z.number().int().min(1).max(INVITATION_TTL_DAYS_MAX).default(INVITATION_TTL_DAYS_DEFAULT),
  /** Language of the invitation mail; the deployment default otherwise. */
  lang: z.enum(['zh', 'en']).optional(),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

export const ListInvitationsQuery = z.object({
  status: z.enum(INVITATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInvitationsQuery = z.infer<typeof ListInvitationsQuery>;

export interface Invitation {
  id: string;
  email: string;
  status: InvitationStatus;
  delivery: InvitationDelivery;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
}

/** Creation answer; `url` only for `delivery: "link"` (no mail transport), shown once. */
export interface CreatedInvitation extends Invitation {
  url?: string;
}

/**
 * Answer of an identity RPC method that can fail with a platform error: Workers RPC keeps only the
 * message of a thrown error, so the error code travels as data and the api worker rethrows it.
 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } };
