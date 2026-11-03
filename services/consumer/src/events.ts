import {
  EVENT_ROW_PROPERTIES_MAX_BYTES, EventInput, PRODUCT_ID_RE, isEnvironment, type EventContext, type EventQueueMessage, type QueuedEvent,
} from '@z-cloudbase/contracts';
import { batchId, groupBy, pad } from './archive.ts';

const DAY_MS = 24 * 3600 * 1000;
const EMPTY_CONTEXT: EventContext = { source: 'client', browser: '', os: '', device: '', country: '' };

interface Parsed {
  product_id: string;
  environment: string;
  received_at: string;
  context: EventContext;
  dimensions: string[];
  events: Array<{ user_key: string | null; event: QueuedEvent }>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** v3.1 messages (many events, server context) and v3.0 messages (one event) still on the queue after an upgrade. */
export function parseEventMessage(body: unknown): Parsed | null {
  const m = body as Record<string, unknown> | null;
  if (!m || typeof m.product_id !== 'string' || !PRODUCT_ID_RE.test(m.product_id) || !isEnvironment(m.environment)) return null;
  if (typeof m.received_at !== 'string' || Number.isNaN(Date.parse(m.received_at))) return null;
  const parseItem = (it: unknown) => {
    const i = it as { user_key?: unknown; event?: unknown } | null;
    if (!i || (i.user_key !== null && typeof i.user_key !== 'string')) return null;
    const event = EventInput.safeParse(i.event);
    if (!event.success || event.data.user_id !== undefined) return null;
    return { user_key: i.user_key as string | null, event: event.data as QueuedEvent };
  };
  if (m.v === 2) {
    const c = m.context as Record<string, unknown> | null;
    if (!c || (c.source !== 'client' && c.source !== 'server') || !Array.isArray(m.events) || m.events.length === 0) return null;
    const events = m.events.map(parseItem);
    if (events.some((e) => e === null)) return null;
    return {
      product_id: m.product_id, environment: m.environment, received_at: m.received_at,
      context: { source: c.source, browser: str(c.browser, 16), os: str(c.os, 16), device: str(c.device, 16), country: str(c.country, 2) },
      dimensions: Array.isArray(m.dimensions) ? m.dimensions.filter((d): d is string => typeof d === 'string').slice(0, 3) : [],
      events: events as Parsed['events'],
    };
  }
  const one = parseItem(m);
  return one ? { product_id: m.product_id, environment: m.environment, received_at: m.received_at, context: EMPTY_CONTEXT, dimensions: [], events: [one] } : null;
}

/** `path` dimension: the query string and a non-route fragment are dropped (PRD §21.7). */
export function pathDimension(v: unknown): string {
  if (typeof v !== 'string') return '';
  let p = v.split('?')[0]!;
  const hash = p.indexOf('#');
  if (hash >= 0 && !p.startsWith('#/', hash)) p = p.slice(0, hash);
  return p.slice(0, 256);
}

const dimValue = (v: unknown) => (v === undefined || v === null ? '' : String(v).slice(0, 128));

/** One consumed event with everything derived for the stores. */
export interface EventRecord {
  id: string;
  name: string;
  userKey: string | null;
  anonymousId: string | null;
  sessionId: string | null;
  occurredAt: number;
  receivedAt: number;
  day: number;
  actor: string | null;
  context: EventContext;
  path: string;
  dimKeys: string[];
  dims: string[];
  properties: Record<string, unknown>;
  /** Archive line (PRD §21.9). */
  archive: Record<string, unknown>;
}

function toRecord(p: Parsed, item: Parsed['events'][number]): EventRecord {
  const e = item.event;
  const occurredAt = Date.parse(e.occurred_at);
  const anonymousId = e.anonymous_id ?? null;
  return {
    id: e.event_id,
    name: e.event_name,
    userKey: item.user_key,
    anonymousId,
    sessionId: e.session_id ?? null,
    occurredAt,
    receivedAt: Date.parse(p.received_at),
    day: Math.floor(occurredAt / DAY_MS),
    actor: item.user_key ?? (anonymousId ? `anon:${anonymousId}` : null),
    context: p.context,
    path: pathDimension(e.properties.path),
    dimKeys: p.dimensions,
    dims: [0, 1, 2].map((i) => (p.dimensions[i] ? dimValue(e.properties[p.dimensions[i]!]) : '')),
    properties: e.properties,
    archive: {
      event_id: e.event_id, event_name: e.event_name, occurred_at: e.occurred_at, received_at: p.received_at,
      user_key: item.user_key, anonymous_id: anonymousId, session_id: e.session_id ?? null, schema_version: e.schema_version,
      properties: e.properties, context: p.context,
    },
  };
}

/** Dimensions of an occurrence as stored in `actor_daily.dims` (keys = breakdown / filter dimension names). */
function dimsObject(r: EventRecord): Record<string, string> {
  const o: Record<string, string> = { path: r.path, ...r.context };
  r.dimKeys.forEach((k, i) => (o[`prop:${k}`] = r.dims[i]!));
  return o;
}

/** `events/v2/{yyyy}/{mm}/{dd}/{product}/{env}/` — date first, so expiry removes whole days (PRD §21.9). */
export function archiveDayPrefix(day: number, productId?: string, env?: string): string {
  const d = new Date(day * DAY_MS);
  const date = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  return `events/v2/${date}/${productId !== undefined ? `${productId}/${env}/` : ''}`;
}

export async function gzipText(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Events → gzip NDJSON archive, `event_rows`, actor tables and Analytics Engine (PRD §9, §21.7–21.9).
 * Messages are grouped per product environment; each group is one archive object per occurrence day and
 * one D1 transaction of three bulk statements. Only events not yet in `event_rows` reach Analytics Engine
 * and the actor tables, so redelivery never double-counts. A failing group retries its own messages only.
 */
export async function handleEvents(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const valid: Array<{ msg: Message<unknown>; p: Parsed }> = [];
  for (const msg of batch.messages) {
    const p = parseEventMessage(msg.body);
    if (p) valid.push({ msg, p });
    else {
      console.error(JSON.stringify({ msg: 'malformed event message', id: msg.id }));
      msg.retry();
    }
  }

  const groups = groupBy(valid, ({ p }) => `${p.product_id}.${p.environment}`);
  for (const [productEnvId, items] of groups) {
    try {
      const { product_id: productId, environment } = items[0]!.p;
      const seen = new Set<string>();
      const records: EventRecord[] = [];
      for (const { p } of items) {
        for (const it of p.events) {
          if (seen.has(it.event.event_id)) continue;
          seen.add(it.event.event_id);
          records.push(toRecord(p, it));
        }
      }

      const id = await batchId(items.map((i) => i.msg.id));
      for (const [day, dayRecords] of groupBy(records, (r) => String(r.day))) {
        const body = dayRecords.map((r) => JSON.stringify(r.archive)).join('\n') + '\n';
        await env.ARCHIVE.put(`${archiveDayPrefix(Number(day), productId, environment)}${id}.ndjson.gz`, await gzipText(body), {
          httpMetadata: { contentType: 'application/gzip' },
        });
      }

      const { results: existing } = await env.INGEST_DB.prepare(
        'SELECT event_id FROM event_rows WHERE product_env_id = ? AND event_id IN (SELECT value FROM json_each(?))',
      ).bind(productEnvId, JSON.stringify(records.map((r) => r.id))).all<{ event_id: string }>();
      const stored = new Set(existing.map((r) => r.event_id));
      const fresh = records.filter((r) => !stored.has(r.id));

      if (fresh.length > 0) {
        await env.INGEST_DB.batch(storeStatements(env.INGEST_DB, productEnvId, fresh));
        for (const r of fresh) {
          env.EVENTS_AE.writeDataPoint({
            indexes: [productEnvId],
            blobs: [productId, environment, r.name, r.userKey ?? '', r.anonymousId ?? '', r.path, r.context.browser, r.context.os,
              r.context.device, r.context.country, r.context.source, ...r.dims],
            doubles: [1],
          });
        }
      }
      for (const { msg } of items) msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: 'event batch failed', group: productEnvId, error: String(err) }));
      for (const { msg } of items) msg.retry();
    }
  }
}

/** Three bulk statements (one transaction via batch): event rows, per-actor-day rows, actor first / last day. */
function storeStatements(db: D1Database, productEnvId: string, fresh: EventRecord[]): D1PreparedStatement[] {
  const rows = fresh.map((r) => {
    const props = JSON.stringify(r.properties);
    const keep = utf8Bytes(props) <= EVENT_ROW_PROPERTIES_MAX_BYTES;
    return {
      id: r.id, n: r.name, u: r.userKey, a: r.anonymousId, s: r.sessionId, o: r.occurredAt, r: r.receivedAt,
      src: r.context.source, b: r.context.browser, os: r.context.os, dv: r.context.device, c: r.context.country, p: r.path,
      d1: r.dims[0], d2: r.dims[1], d3: r.dims[2], dk: JSON.stringify(r.dimKeys), pr: keep ? props : null, t: keep ? 0 : 1,
    };
  });

  const daily = new Map<string, { e: string; d: number; a: string; f: number; l: number; n: number; m: Record<string, string> }>();
  const actors = new Map<string, { a: string; f: number; l: number }>();
  for (const r of fresh) {
    if (!r.actor) continue;
    const k = `${r.name}\u0000${r.day}\u0000${r.actor}`;
    const cur = daily.get(k);
    if (!cur) daily.set(k, { e: r.name, d: r.day, a: r.actor, f: r.occurredAt, l: r.occurredAt, n: 1, m: dimsObject(r) });
    else {
      if (r.occurredAt < cur.f) (cur.f = r.occurredAt), (cur.m = dimsObject(r));
      cur.l = Math.max(cur.l, r.occurredAt);
      cur.n++;
    }
    const a = actors.get(r.actor);
    if (!a) actors.set(r.actor, { a: r.actor, f: r.day, l: r.day });
    else (a.f = Math.min(a.f, r.day)), (a.l = Math.max(a.l, r.day));
  }

  const j = (path: string) => `json_extract(value, '$.${path}')`;
  const stmts = [
    db.prepare(
      `INSERT OR IGNORE INTO event_rows (product_env_id, event_id, event_name, user_key, anonymous_id, session_id, occurred_at, received_at,
         source, browser, os, device, country, path, dim1, dim2, dim3, dim_keys, properties, properties_truncated)
       SELECT ?1, ${['id', 'n', 'u', 'a', 's', 'o', 'r', 'src', 'b', 'os', 'dv', 'c', 'p', 'd1', 'd2', 'd3', 'dk', 'pr', 't'].map(j).join(', ')}
       FROM json_each(?2)`,
    ).bind(productEnvId, JSON.stringify(rows)),
  ];
  if (daily.size > 0) {
    stmts.push(
      db.prepare(
        `INSERT INTO actor_daily (product_env_id, event_name, day, actor, first_at, last_at, n, dims)
         SELECT ?1, ${['e', 'd', 'a', 'f', 'l', 'n', 'm'].map(j).join(', ')} FROM json_each(?2) WHERE true
         ON CONFLICT (product_env_id, event_name, day, actor) DO UPDATE SET
           dims = CASE WHEN excluded.first_at < actor_daily.first_at THEN excluded.dims ELSE actor_daily.dims END,
           first_at = min(actor_daily.first_at, excluded.first_at),
           last_at = max(actor_daily.last_at, excluded.last_at),
           n = actor_daily.n + excluded.n`,
      ).bind(productEnvId, JSON.stringify([...daily.values()])),
      db.prepare(
        `INSERT INTO actors (product_env_id, actor, first_day, last_day)
         SELECT ?1, ${['a', 'f', 'l'].map(j).join(', ')} FROM json_each(?2) WHERE true
         ON CONFLICT (product_env_id, actor) DO UPDATE SET
           first_day = min(actors.first_day, excluded.first_day), last_day = max(actors.last_day, excluded.last_day)
         WHERE excluded.first_day < actors.first_day OR excluded.last_day > actors.last_day`,
      ).bind(productEnvId, JSON.stringify([...actors.values()])),
    );
  }
  return stmts;
}
