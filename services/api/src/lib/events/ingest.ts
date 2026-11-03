import { EVENTS_PER_QUEUE_MESSAGE, EVENTS_QUEUE_MESSAGE_MAX_BYTES, type EventQueueMessage } from '@z-cloudbase/contracts';
import { jsonBytes } from '../ingest/body.ts';

/** Users of `ids` with an active membership in `productId` (one query; ids come from one batch, ≤ 100). */
export async function activeMembers(db: D1Database, productId: string, ids: string[]): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT user_id FROM product_memberships WHERE product_id = ? AND status = 'active' AND user_id IN (SELECT value FROM json_each(?))`,
  ).bind(productId, JSON.stringify(ids)).all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

/** Declared custom dimension keys of a product environment (PRD §21.8); [] when none. */
export async function customDimensions(db: D1Database, productEnvId: string): Promise<string[]> {
  const row = await db.prepare('SELECT dimensions FROM analytics_settings WHERE product_env_id = ?').bind(productEnvId).first<{ dimensions: string }>();
  if (!row) return [];
  try {
    const d = JSON.parse(row.dimensions) as unknown;
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string').slice(0, 3) : [];
  } catch {
    return [];
  }
}

type Item = EventQueueMessage['events'][number];

/**
 * Split accepted events into queue messages of ≤ EVENTS_PER_QUEUE_MESSAGE events and ≤ ~100 KB each,
 * preserving order (PRD §21.7). Packing cuts Queues operations per event by the batch size.
 */
export function packEventMessages(head: Omit<EventQueueMessage, 'events'>, items: Item[]): EventQueueMessage[] {
  const base = jsonBytes({ ...head, events: [] });
  const out: EventQueueMessage[] = [];
  let cur: Item[] = [];
  let bytes = base;
  for (const item of items) {
    const n = jsonBytes(item) + 1;
    if (cur.length > 0 && (cur.length >= EVENTS_PER_QUEUE_MESSAGE || bytes + n > EVENTS_QUEUE_MESSAGE_MAX_BYTES)) {
      out.push({ ...head, events: cur });
      cur = [];
      bytes = base;
    }
    cur.push(item);
    bytes += n;
  }
  if (cur.length > 0) out.push({ ...head, events: cur });
  return out;
}
