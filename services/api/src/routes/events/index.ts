import {
  ApiError, EVENTS_MAX_BATCH_BYTES, EVENTS_MAX_PER_BATCH, EVENT_DEDUP_WINDOW_S, EVENT_MAX_FUTURE_MS, EVENT_MAX_PAST_MS,
  EVENT_MAX_PROPERTIES_BYTES, EVENT_MAX_PROPERTIES_KEYS, EventBatchRequest, EventInput, EventPropertySchema, type BatchRejection, type BatchWarning,
  type EventBatchResponse, type EventQueueMessage,
} from '@z-cloudbase/contracts';
import { requestContext } from '../../lib/events/context.ts';
import { activeMembers, customDimensions, packEventMessages } from '../../lib/events/ingest.ts';
import { userPropertiesRoute } from './user-properties.ts';
import { userKey } from '@z-cloudbase/security';
import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { withCredential, withUser } from '../../middleware/auth.ts';
import { serviceScopeOnly } from '../../lib/ingest/auth.ts';
import { jsonBytes, readBatchBody } from '../../lib/ingest/body.ts';
import { QueueSendError, sendInChunks } from '../../lib/ingest/queue.ts';
import { ingestRateLimit } from '../../lib/ingest/ratelimit.ts';
import { validateProperties } from '../../lib/events/validate.ts';

export const eventsRoutes = new Hono<AppEnv>();


const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const reject = (index: number, code: string, message: string): BatchRejection => ({ index, code, message });

/** Per-event checks beyond the schema: time window and properties size. */
function checkEvent(raw: unknown, index: number, now: number, kind: 'publishable' | 'service'): EventInput | BatchRejection {
  const parsed = EventInput.safeParse(raw);
  if (!parsed.success) return reject(index, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid event');
  const e = parsed.data;
  // A browser attributes events to a user only through that user's token (PRD §21.7).
  if (e.user_id !== undefined && kind !== 'service') return reject(index, 'user_id_not_allowed', 'user_id is accepted only with a service key');
  const t = Date.parse(e.occurred_at);
  if (t < now - EVENT_MAX_PAST_MS || t > now + EVENT_MAX_FUTURE_MS) return reject(index, 'occurred_at_out_of_range', 'occurred_at outside the accepted window');
  if (Object.keys(e.properties).length > EVENT_MAX_PROPERTIES_KEYS) return reject(index, 'validation_failed', `At most ${EVENT_MAX_PROPERTIES_KEYS} properties`);
  if (jsonBytes(e.properties) > EVENT_MAX_PROPERTIES_BYTES) return reject(index, 'payload_too_large', `properties exceed ${EVENT_MAX_PROPERTIES_BYTES} bytes`);
  return e;
}

// POST /v1/events/batch — PRD §4.5, §19.6. Publishable key (optionally with a user token) or service key (events:write).
eventsRoutes.post(
  '/batch',
  withCredential({ allow: ['publishable', 'service'] }),
  serviceScopeOnly('events:write'),
  withUser({ required: false }),
  ingestRateLimit('events'),
  async (c) => {
    const cred = c.get('cred');
    const body = EventBatchRequest.safeParse(await readBatchBody(c.req.raw, EVENTS_MAX_BATCH_BYTES));
    if (!body.success) throw new ApiError('validation_failed', 'Body must be {"events": [...]}', { issues: body.error.issues.map((i) => i.message) });
    if (body.data.events.length > EVENTS_MAX_PER_BATCH) throw new ApiError('payload_too_large', `At most ${EVENTS_MAX_PER_BATCH} events per batch`);

    const now = Date.now();
    const rejected: BatchRejection[] = [];
    const checked: Array<{ index: number; event: EventInput }> = [];
    body.data.events.forEach((raw, index) => {
      const r = checkEvent(raw, index, now, cred.kind);
      if ('code' in r) rejected.push(r);
      else checked.push({ index, event: r });
    });

    // Event registry (PRD §4.5, §19.11). Unregistered (name, version): dev/staging warn, prod follows the environment's policy.
    // Registered but violating the property schema: dev/staging accept with a warning, prod rejects that event.
    const warnings: BatchWarning[] = [];
    let candidates = checked;
    if (checked.length > 0) {
      const [known, envRow] = await c.env.DB.batch([
        c.env.DB.prepare('SELECT event_name, schema_version, json_schema FROM event_schemas WHERE product_env_id = ?').bind(cred.productEnvId),
        c.env.DB.prepare('SELECT unknown_event_policy FROM product_environments WHERE id = ?').bind(cred.productEnvId),
      ]);
      const registry = new Map<string, EventPropertySchema | null>();
      for (const r of known!.results as Array<{ event_name: string; schema_version: number; json_schema: string }>) {
        // Rows that predate the property-schema format are known events without enforceable properties.
        const parsed = EventPropertySchema.safeParse(safeJson(r.json_schema));
        registry.set(`${r.event_name}@${r.schema_version}`, parsed.success ? parsed.data : null);
      }
      const policy = (envRow!.results[0] as { unknown_event_policy: 'accept' | 'reject' } | undefined)?.unknown_event_policy;
      const strict = cred.env === 'prod' && policy === 'reject';
      candidates = checked.filter(({ index, event }) => {
        const key = `${event.event_name}@${event.schema_version}`;
        if (!registry.has(key)) {
          const message = `Event "${event.event_name}" (schema_version ${event.schema_version}) is not registered`;
          if (strict) {
            rejected.push(reject(index, 'unknown_event', message));
            return false;
          }
          if (cred.env !== 'prod') warnings.push({ index, code: 'unknown_event', message });
          return true;
        }
        const schema = registry.get(key);
        const problems = schema ? validateProperties(schema, event.properties) : [];
        if (problems.length === 0) return true;
        const message = `Properties violate the registered schema: ${problems.join('; ')}`;
        if (cred.env === 'prod') {
          rejected.push(reject(index, 'schema_violation', message));
          return false;
        }
        warnings.push({ index, code: 'schema_violation', message });
        return true;
      });
    }

    // Service-key events may name a user; only users with an active membership in this product are accepted.
    const named = [...new Set(candidates.flatMap(({ event }) => (event.user_id ? [event.user_id] : [])))];
    if (named.length > 0) {
      const members = await activeMembers(c.env.DB, cred.productId, named);
      candidates = candidates.filter(({ index, event }) => {
        if (!event.user_id || members.has(event.user_id)) return true;
        rejected.push(reject(index, 'membership_required', 'user_id has no active membership in this product'));
        return false;
      });
    }

    // Dedupe within the window; an expired-but-unpurged row is taken over, a live one counts as duplicate.
    let fresh = candidates;
    if (candidates.length > 0) {
      const expiresAt = now + EVENT_DEDUP_WINDOW_S * 1000;
      let results: D1Result[];
      try {
        results = await c.env.INGEST_DB.batch(candidates.map(({ event }) =>
          c.env.INGEST_DB.prepare(
            `INSERT INTO event_dedup (product_env_id, event_id, expires_at) VALUES (?, ?, ?)
             ON CONFLICT (product_env_id, event_id) DO UPDATE SET expires_at = excluded.expires_at WHERE event_dedup.expires_at <= ?`,
          ).bind(cred.productEnvId, event.event_id, expiresAt, now)));
      } catch (err) {
        console.error(JSON.stringify({ request_id: c.get('requestId'), msg: 'event dedupe failed', error: String(err) }));
        throw new ApiError('unavailable', 'Event store unavailable, retry later');
      }
      fresh = candidates.filter((_, i) => results[i]!.meta.changes > 0);
    }
    const duplicate = candidates.length - fresh.length;

    if (fresh.length > 0) {
      const user = c.get('user');
      const tokenKey = user ? await userKey(user.userId, cred.userKeySalt) : null;
      const keys = new Map<string, string>();
      for (const id of named) keys.set(id, await userKey(id, cred.userKeySalt));
      const messages: EventQueueMessage[] = packEventMessages(
        {
          v: 2, product_id: cred.productId, environment: cred.env, received_at: new Date(now).toISOString(),
          context: requestContext(c.req.raw, cred.kind), dimensions: await customDimensions(c.env.INGEST_DB, cred.productEnvId),
        },
        fresh.map(({ event: { user_id, ...event } }) => ({ user_key: user_id ? keys.get(user_id)! : tokenKey, event })),
      );
      try {
        await sendInChunks(c.env.EVENTS_QUEUE, messages);
      } catch (err) {
        // Release the dedupe claim of everything not enqueued so the client's retry is not dropped as duplicate.
        const sentMessages = err instanceof QueueSendError ? err.sent : 0;
        const sentEvents = messages.slice(0, sentMessages).reduce((n, m) => n + m.events.length, 0);
        const unsent = fresh.slice(sentEvents);
        console.error(JSON.stringify({ request_id: c.get('requestId'), msg: 'events enqueue failed', unsent: unsent.length, error: String(err) }));
        try {
          await c.env.INGEST_DB.batch(unsent.map(({ event }) =>
            c.env.INGEST_DB.prepare('DELETE FROM event_dedup WHERE product_env_id = ? AND event_id = ?').bind(cred.productEnvId, event.event_id)));
        } catch (cleanupErr) {
          console.error(JSON.stringify({ request_id: c.get('requestId'), msg: 'event dedupe rollback failed', error: String(cleanupErr) }));
        }
        throw new ApiError('unavailable', 'Event queue unavailable, retry later');
      }
    }

    const res: EventBatchResponse = {
      accepted: fresh.length,
      duplicate,
      rejected: rejected.sort((a, b) => a.index - b.index),
    };
    if (warnings.length > 0) res.warnings = warnings;
    return c.json(res, 202);
  },
);

// POST /v1/events/user-properties — PRD §21.7.
eventsRoutes.post(
  '/user-properties',
  withCredential({ allow: ['publishable', 'service'] }),
  serviceScopeOnly('events:write'),
  withUser({ required: false }),
  ingestRateLimit('user_properties'),
  userPropertiesRoute,
);
