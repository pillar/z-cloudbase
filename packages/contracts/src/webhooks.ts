// Product webhooks — PRD §21.6. Event payload schemas, endpoint requests and delivery limits.
import { z } from 'zod';
import { ENVIRONMENTS, PRODUCT_ID_RE } from './ids.ts';

/** Event types an endpoint can subscribe to. `webhook.test` is sent only by the console's test button. */
export const WEBHOOK_EVENT_TYPES = ['user.joined', 'user.upgraded', 'user.deleted', 'user.banned', 'user.unbanned'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export const WEBHOOK_MAX_ENDPOINTS_PER_ENV = 10;
export const WEBHOOK_URL_MAX = 2048;
export const WEBHOOK_DESCRIPTION_MAX = 200;
/** Attempts per delivery, the first one included (PRD §21.6). */
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_RETRY_BASE_S = 15 * 60;
export const WEBHOOK_RETRY_MAX_S = 12 * 3600;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** A claimed delivery is not picked up again for this long (crashed sender). */
export const WEBHOOK_LEASE_S = 5 * 60;
export const WEBHOOK_RESPONSE_SNIPPET_MAX = 256;
export const WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT = 100;
export const WEBHOOK_RETENTION_DAYS = 30;
/** After a rotation the previous secret keeps signing (second signature) for this long. */
export const WEBHOOK_SECRET_GRACE_S = 24 * 3600;
/** Accepted clock skew of `webhook-timestamp` when verifying. */
export const WEBHOOK_TOLERANCE_S = 5 * 60;
export const WEBHOOK_RETRIES_PER_TICK = 100;

/** Delay before attempt `n + 1` after `n` failed attempts (n >= 1): 15 min × 2^(n−1), at most 12 h. */
export function webhookBackoffS(failedAttempts: number): number {
  return Math.min(WEBHOOK_RETRY_BASE_S * 2 ** Math.max(0, failedAttempts - 1), WEBHOOK_RETRY_MAX_S);
}

const UserId = z.string().startsWith('usr_');

export const WebhookEventData = {
  'user.joined': z.object({ user_id: UserId, anonymous: z.boolean(), first_seen_at: z.iso.datetime() }),
  'user.upgraded': z.object({ user_id: UserId, provider: z.string() }),
  'user.deleted': z.object({ user_id: UserId, scope: z.enum(['account', 'product']) }),
  'user.banned': z.object({ user_id: UserId, expires_at: z.iso.datetime().nullable() }),
  'user.unbanned': z.object({ user_id: UserId, reason: z.enum(['admin', 'expired']) }),
  'webhook.test': z.object({ webhook_id: z.string().startsWith('whe_') }),
} as const;
export type WebhookEventData<T extends keyof typeof WebhookEventData> = z.infer<(typeof WebhookEventData)[T]>;

const envelope = <T extends keyof typeof WebhookEventData>(type: T) =>
  z.object({
    id: z.string().startsWith('msg_'),
    type: z.literal(type),
    timestamp: z.iso.datetime(),
    product_id: z.string().regex(PRODUCT_ID_RE),
    env: z.enum(ENVIRONMENTS),
    data: WebhookEventData[type],
  });

/** Request body of every webhook delivery. */
export const WebhookEvent = z.discriminatedUnion('type', [
  envelope('user.joined'),
  envelope('user.upgraded'),
  envelope('user.deleted'),
  envelope('user.banned'),
  envelope('user.unbanned'),
  envelope('webhook.test'),
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const CreateWebhookRequest = z.object({
  url: z.string().min(1).max(WEBHOOK_URL_MAX),
  description: z.string().max(WEBHOOK_DESCRIPTION_MAX).optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  enabled: z.boolean().default(true),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const UpdateWebhookRequest = z.object({
  url: z.string().min(1).max(WEBHOOK_URL_MAX).optional(),
  description: z.string().max(WEBHOOK_DESCRIPTION_MAX).nullable().optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequest>;

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'cancelled'] as const;

/** Endpoint as returned by the admin API (never the secret, except once on create / rotate). */
export interface WebhookEndpoint {
  id: string;
  product_id: string;
  env: (typeof ENVIRONMENTS)[number];
  url: string;
  description: string | null;
  event_types: WebhookEventType[];
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** One delivery attempt in the endpoint's log. */
export interface WebhookAttempt {
  id: string;
  message_id: string;
  event_type: string;
  attempt: number;
  attempted_at: number;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  response_snippet: string | null;
  /** Current state of the delivery this attempt belongs to (null once the delivery was pruned). */
  delivery_status: (typeof WEBHOOK_DELIVERY_STATUSES)[number] | null;
}
