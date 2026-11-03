import { z } from 'zod';
import { ENVIRONMENTS } from './ids.ts';
import { MEMBERSHIP_STATUSES } from './admin.ts';

/** `GET /v1/me`: the user as seen by ONE product environment (never other products). */
export const MeResponse = z.object({
  user_id: z.string().startsWith('usr_'),
  anonymous: z.boolean(),
  product_id: z.string(),
  env: z.enum(ENVIRONMENTS),
  membership: z.object({ status: z.enum(MEMBERSHIP_STATUSES), joined_at: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SELF_SERVICE_REQUEST_STATUSES = ['pending', 'cancelled', 'processing', 'completed', 'failed'] as const;

/**
 * A deletion / export request as shown to its own user (PRD §19.8). The internal storage path of
 * an export (`result_ref`) is never exposed. Product APIs only show `scope: 'product'` requests of
 * their own product; account-scoped requests live on the identity domain.
 */
export const SelfServiceRequest = z.object({
  id: z.string(),
  kind: z.enum(['delete', 'export']),
  scope: z.enum(['account', 'product']),
  status: z.enum(SELF_SERVICE_REQUEST_STATUSES),
  requested_at: z.string(),
  due_at: z.string(),
  completed_at: z.string().nullable(),
});
export type SelfServiceRequest = z.infer<typeof SelfServiceRequest>;

export const SelfServiceRequestList = z.object({ requests: z.array(SelfServiceRequest) });
export type SelfServiceRequestList = z.infer<typeof SelfServiceRequestList>;
