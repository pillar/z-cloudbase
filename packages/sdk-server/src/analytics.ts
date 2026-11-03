import {
  EVENTS_MAX_BATCH_BYTES, EVENTS_MAX_PER_BATCH, EVENT_MAX_PROPERTIES_BYTES, EVENT_MAX_PROPERTIES_KEYS, EVENT_NAME_RE,
  type EventBatchResponse, type EventInput,
} from '@z-cloudbase/contracts';
import { byteLength, createBatcher } from './batcher.ts';
import { PlatformError } from './errors.ts';
import type { Http } from './http.ts';

type Scalar = string | number | boolean | null;

export interface ServerEventOptions {
  /**
   * Attribute the event to this user (PRD §21.7). The API accepts it only for users with an active membership
   * in the service key's product and stores just the per-product pseudonym; other users' events are rejected.
   */
  userId?: string;
  /** Caller-chosen id for end-to-end dedupe (e.g. a job id); a UUID is generated otherwise. */
  eventId?: string;
  anonymousId?: string;
  sessionId?: string;
  occurredAt?: Date;
}

export function createAnalytics(
  http: Http, opts: { flushIntervalMs?: number | undefined; onError?: ((e: PlatformError) => void) | undefined },
) {
  const batcher = createBatcher<EventInput>({
    // event_id is fixed when the event is queued, so a retried batch is deduplicated by the API.
    send: (events) => http<EventBatchResponse>('/events/batch', { method: 'POST', body: { events }, retries: 3 }),
    maxItems: EVENTS_MAX_PER_BATCH,
    maxBytes: EVENTS_MAX_BATCH_BYTES,
    ...opts,
  });

  /**
   * Queue a service-side event. The service key identifies the product and env; `userId` (optional) must be
   * an active member of that product. Throws `validation_failed` for a bad name or oversized properties.
   */
  function track(name: string, properties: Record<string, unknown> = {}, o: ServerEventOptions = {}): void {
    if (!EVENT_NAME_RE.test(name)) throw new PlatformError('validation_failed', 'Invalid event name');
    const props: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (Object.keys(props).length >= EVENT_MAX_PROPERTIES_KEYS) break;
      if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
        props[k.slice(0, 64)] = typeof v === 'string' ? v.slice(0, 1024) : v;
      }
    }
    if (byteLength(JSON.stringify(props)) > EVENT_MAX_PROPERTIES_BYTES) {
      throw new PlatformError('validation_failed', 'Event properties are too large');
    }
    const event: EventInput = {
      event_id: o.eventId ?? crypto.randomUUID(),
      event_name: name,
      occurred_at: (o.occurredAt ?? new Date()).toISOString(),
      ...(o.anonymousId ? { anonymous_id: o.anonymousId } : {}),
      ...(o.sessionId ? { session_id: o.sessionId } : {}),
      ...(o.userId ? { user_id: o.userId } : {}),
      properties: props,
      schema_version: 1,
    };
    batcher.add(event, byteLength(JSON.stringify(event)) + 1);
  }

  return {
    track,
    /** Same as `track` (v0.1 name). */
    trackServerEvent: track,
    /**
     * Merge product-scoped properties of a member of this product (RFC 7396: `null` removes a key). Resolves
     * with the merged properties; rejects with `membership_required`, `validation_failed` or `payload_too_large`.
     */
    async setUserProperties(userId: string, properties: Record<string, string | number | boolean | null>): Promise<Record<string, unknown>> {
      const res = await http<{ properties: Record<string, unknown> }>('/events/user-properties', {
        method: 'POST', body: { user_id: userId, properties }, retries: 3,
      });
      return res.properties;
    },
    /** Send everything buffered. Never rejects; in Workers pass it to `ctx.waitUntil`. */
    flush: () => batcher.flush(),
    stop: () => batcher.stop(),
  };
}
