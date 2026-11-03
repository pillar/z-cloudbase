// Webhook verification for product backends (PRD §21.6): Standard Webhooks signatures over the raw body.
import { WEBHOOK_TOLERANCE_S, type WebhookEvent } from '@z-cloudbase/contracts';
import { WebhookVerificationError, verifyWebhookSignature } from '@z-cloudbase/security';
import { PlatformError } from './errors.ts';

export type { WebhookEvent, WebhookEventType } from '@z-cloudbase/contracts';

export interface VerifyWebhookOptions {
  /** The endpoint's signing secret (`whsec_…`), shown once in the console when created or rotated. */
  secret: string;
  /** Request headers: a `Headers` object (fetch / Workers) or Node's `req.headers`. */
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The raw request body exactly as received (verify before parsing JSON). */
  body: string;
  /** Accepted clock skew of `webhook-timestamp` in seconds (default 300). */
  toleranceS?: number;
}

/**
 * Verify a webhook from the platform and return its event. Checks the `webhook-signature` (HMAC-SHA256,
 * constant-time; during a secret rotation either signature matches) and that `webhook-timestamp` is
 * within the tolerance. Throws `PlatformError('invalid_signature')` otherwise. Deduplicate on `event.id`
 * (= `webhook-id`): deliveries are at-least-once and retried for about a day.
 */
export async function verifyWebhook(o: VerifyWebhookOptions): Promise<WebhookEvent> {
  try {
    await verifyWebhookSignature({ secret: o.secret, headers: o.headers, body: o.body, toleranceS: o.toleranceS ?? WEBHOOK_TOLERANCE_S });
  } catch (e) {
    if (e instanceof WebhookVerificationError) throw new PlatformError('invalid_signature', e.message, { status: 401 });
    throw new PlatformError('invalid_signature', 'Webhook secret or signature is malformed', { status: 401 });
  }
  try {
    return JSON.parse(o.body) as WebhookEvent;
  } catch {
    throw new PlatformError('invalid_signature', 'Webhook body is not JSON', { status: 400 });
  }
}
