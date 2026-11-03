import { EventInput, PRODUCT_ID_RE, isEnvironment, type EventQueueMessage } from '@z-cloudbase/contracts';
import { batchId, datePath, groupBy, toNdjson } from './archive.ts';

function parseEventMessage(body: unknown): EventQueueMessage | null {
  const m = body as Partial<EventQueueMessage> | null;
  if (!m || typeof m.product_id !== 'string' || !PRODUCT_ID_RE.test(m.product_id) || !isEnvironment(m.environment)) return null;
  if (m.user_key !== null && typeof m.user_key !== 'string') return null;
  if (typeof m.received_at !== 'string' || Number.isNaN(Date.parse(m.received_at))) return null;
  const event = EventInput.safeParse(m.event);
  return event.success ? { ...(m as EventQueueMessage), event: event.data } : null;
}

/**
 * Events → raw NDJSON archive, D1 substitute table and Analytics Engine (PRD §9). The substitute
 * table's primary key makes redelivery idempotent: a data point is written to AE only for rows
 * newly inserted, so retries never double-count. Failing groups retry only their own messages.
 */
export async function handleEvents(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const valid: Array<{ msg: Message<unknown>; ev: EventQueueMessage }> = [];
  for (const msg of batch.messages) {
    const ev = parseEventMessage(msg.body);
    if (ev) valid.push({ msg, ev });
    else {
      console.error(JSON.stringify({ msg: 'malformed event message', id: msg.id }));
      msg.retry();
    }
  }

  const groups = groupBy(valid, ({ ev }) => `${ev.product_id}/${ev.environment}/${datePath(ev.received_at)}`);
  for (const [prefix, items] of groups) {
    try {
      await env.ARCHIVE.put(`events/${prefix}/${await batchId(items.map((i) => i.msg.id))}.ndjson`, toNdjson(items.map((i) => i.ev)));
      const results = await env.INGEST_DB.batch(items.map(({ ev }) =>
        env.INGEST_DB.prepare(
          `INSERT OR IGNORE INTO events_substitute (product_env_id, event_id, event_name, user_key, anonymous_id, occurred_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `${ev.product_id}.${ev.environment}`, ev.event.event_id, ev.event.event_name, ev.user_key,
          ev.event.anonymous_id ?? null, Date.parse(ev.event.occurred_at), Date.parse(ev.received_at),
        )));
      items.forEach(({ ev }, i) => {
        if (results[i]!.meta.changes === 0) return;
        env.EVENTS_AE.writeDataPoint({
          indexes: [`${ev.product_id}.${ev.environment}`],
          blobs: [ev.product_id, ev.environment, ev.event.event_name, ev.user_key ?? '', ev.event.anonymous_id ?? ''],
          doubles: [1],
        });
      });
      for (const { msg } of items) msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: 'event batch failed', group: prefix, error: String(err) }));
      for (const { msg } of items) msg.retry();
    }
  }
}
