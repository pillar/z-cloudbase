// Structured product-log search used by admin routes (owned by the ingest/consumer module).
// No full-text search (PRD D07): product env + time window + optional request_id / level.
import type { LogEntryInput, LogQueueMessage, LogSource } from '@z-cloudbase/contracts';

export interface LogSearchInput {
  productEnvId: string;
  /** Epoch ms, inclusive / exclusive. */
  from: number;
  to: number;
  requestId?: string;
  level?: LogEntryInput['level'];
  limit?: number;
  /** Decoded `next_before` of the previous page: only entries after that position (older) are returned. */
  before?: LogCursor;
}

export interface LogRecord {
  received_at: string;
  source: LogSource;
  ingest_request_id: string;
  entry: LogEntryInput;
}

export interface LogSearchResult {
  /** Newest first. */
  logs: LogRecord[];
  /** Cursor for the next (older) page; null when nothing older matches. */
  next_before: string | null;
}

/**
 * Position in the newest-first order: entry timestamp (ms) descending, then archive key and line
 * descending. A total order, so entries with the same timestamp page deterministically.
 */
export interface LogCursor {
  at: number;
  key: string;
  line: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Upper bound on archive objects opened per search. */
const MAX_ARCHIVE_OBJECTS = 50;
/** Line of a cursor placed in front of a whole archive object. */
const OBJECT_START = Number.MAX_SAFE_INTEGER;

/** Opaque to clients: `<ms>:<line>:<archive key>` (the key may itself contain `:`). */
export const encodeLogCursor = (c: LogCursor) => `${c.at}:${c.line}:${c.key}`;
export function decodeLogCursor(s: string): LogCursor | null {
  const m = /^(\d{1,16}):(\d{1,16}):(.{1,1024})$/s.exec(s);
  if (!m) return null;
  const at = Number(m[1]);
  const line = Number(m[2]);
  return Number.isSafeInteger(at) && Number.isSafeInteger(line) ? { at, line, key: m[3]! } : null;
}

/** Newest-first comparison: negative when `a` comes before (is newer than) `b`. */
function compare(a: LogCursor, b: LogCursor): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.key !== b.key) return a.key < b.key ? 1 : -1;
  return b.line - a.line;
}

type Found = LogRecord & { pos: LogCursor };

/**
 * Newest first, paged with `before`. `log_index` locates the archive objects (one row per entry
 * request_id and per ingest request id, so every entry is reachable by time window and level); the
 * objects are read in order of their newest matching index row and filtered exactly.
 *
 * An entry is returned only once no unread object can hold a newer one: unread objects are ordered
 * by (newest indexed time, key) descending, so every entry ahead of the next unread object's
 * (time, key) is final. If the object budget runs out first, the page ends there and `next_before`
 * points in front of the first unread object. Browser-sourced records keep `source: 'browser'`.
 */
export async function searchLogs(env: Pick<Env, 'INGEST_DB' | 'ARCHIVE'>, input: LogSearchInput): Promise<LogSearchResult> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const before = input.before;
  const where = ['product_env_id = ?', 'occurred_at >= ?', 'occurred_at < ?'];
  const binds: unknown[] = [input.productEnvId, input.from, input.to];
  if (input.requestId) { where.push('request_id = ?'); binds.push(input.requestId); }
  if (input.level) { where.push('level = ?'); binds.push(input.level); }
  if (before) { where.push('(occurred_at < ? OR (occurred_at = ? AND archive_key <= ?))'); binds.push(before.at, before.at, before.key); }
  const { results: objects } = await env.INGEST_DB.prepare(
    `SELECT archive_key, MAX(occurred_at) AS latest FROM log_index WHERE ${where.join(' AND ')}
     GROUP BY archive_key ORDER BY latest DESC, archive_key DESC LIMIT ${MAX_ARCHIVE_OBJECTS + 1}`,
  ).bind(...binds).all<{ archive_key: string; latest: number }>();

  const pending: Found[] = [];
  const final: Found[] = [];
  let unread: LogCursor | null = null;
  for (let i = 0; i < objects.length; i++) {
    const key = objects[i]!.archive_key;
    for (const r of await readObject(env, key, input)) if (!before || compare(r.pos, before) > 0) pending.push(r);
    const next = objects[i + 1];
    const bound = next ? { at: next.latest, key: next.archive_key, line: OBJECT_START } : null;
    pending.sort((a, b) => compare(a.pos, b.pos));
    const cut = bound ? pending.findIndex((r) => compare(r.pos, bound) > 0) : -1;
    final.push(...pending.splice(0, cut === -1 ? pending.length : cut));
    if (final.length > limit) break;
    if (bound && i + 1 === MAX_ARCHIVE_OBJECTS) {
      unread = bound;
      break;
    }
  }

  const page = final.slice(0, limit);
  const next = final.length > limit ? page.at(-1)!.pos : unread;
  return { logs: page.map(({ pos: _pos, ...r }) => r), next_before: next ? encodeLogCursor(next) : null };
}

async function readObject(env: Pick<Env, 'ARCHIVE'>, key: string, input: LogSearchInput): Promise<Found[]> {
  const obj = await env.ARCHIVE.get(key);
  if (!obj) return [];
  const out: Found[] = [];
  const lines = (await obj.text()).split('\n');
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line]) continue;
    let m: LogQueueMessage;
    try {
      m = JSON.parse(lines[line]!) as LogQueueMessage;
    } catch {
      continue;
    }
    const at = Date.parse(m.entry.timestamp);
    if (`${m.product_id}.${m.environment}` !== input.productEnvId) continue;
    if (!(at >= input.from && at < input.to)) continue;
    if (input.level && m.entry.level !== input.level) continue;
    if (input.requestId && m.entry.request_id !== input.requestId && m.ingest_request_id !== input.requestId) continue;
    out.push({ received_at: m.received_at, source: m.source, ingest_request_id: m.ingest_request_id, entry: m.entry, pos: { at, key, line } });
  }
  return out;
}
