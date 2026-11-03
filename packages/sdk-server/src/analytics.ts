import {
  EVENTS_MAX_BATCH_BYTES, EVENTS_MAX_PER_BATCH, EVENT_MAX_PROPERTIES_BYTES, EVENT_MAX_PROPERTIES_KEYS, EVENT_NAME_RE,
  type EventBatchResponse, type EventInput,
} from '@z-cloudbase/contracts';
import { byteLength, createBatcher } from './batcher.ts';
import { PlatformError } from './errors.ts';
import type { Http } from './http.ts';

type Scalar = string | number | boolean | null;

export interface ServerEventOptions {
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

  return {
    /**
     * Queue a service-side event. The service key identifies the product and env; events carry no
     * user (the API only attributes events to a user from that user's own access token).
     * Throws `validation_failed` for a bad name or oversized properties.
     */
    trackServerEvent(name: string, properties: Record<string, unknown> = {}, o: ServerEventOptions = {}): void {
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
        properties: props,
        schema_version: 1,
      };
      batcher.add(event, byteLength(JSON.stringify(event)) + 1);
    },
    /** Send everything buffered. Never rejects; in Workers pass it to `ctx.waitUntil`. */
    flush: () => batcher.flush(),
    stop: () => batcher.stop(),
  };
}
