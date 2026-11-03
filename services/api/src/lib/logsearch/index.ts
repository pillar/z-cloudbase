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
}

export interface LogRecord {
  received_at: string;
  source: LogSource;
  ingest_request_id: string;
  entry: LogEntryInput;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Upper bound on archive objects opened per search. */
const MAX_ARCHIVE_OBJECTS = 50;

/**
 * `log_index` locates the archive objects (it holds one row per entry request_id and per ingest
 * request id, so every entry is reachable by time window and level); the objects are then read and
 * filtered exactly. Browser-sourced records are returned with `source: 'browser'` and are untrusted.
 */
export async function searchLogs(env: Pick<Env, 'INGEST_DB' | 'ARCHIVE'>, input: LogSearchInput): Promise<LogRecord[]> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const where = ['product_env_id = ?', 'occurred_at >= ?', 'occurred_at < ?'];
  const binds: unknown[] = [input.productEnvId, input.from, input.to];
  if (input.requestId) { where.push('request_id = ?'); binds.push(input.requestId); }
  if (input.level) { where.push('level = ?'); binds.push(input.level); }
  const { results } = await env.INGEST_DB.prepare(
    `SELECT DISTINCT archive_key FROM log_index WHERE ${where.join(' AND ')} ORDER BY archive_key LIMIT ${MAX_ARCHIVE_OBJECTS}`,
  ).bind(...binds).all<{ archive_key: string }>();

  const out: LogRecord[] = [];
  for (const { archive_key } of results) {
    const obj = await env.ARCHIVE.get(archive_key);
    if (!obj) continue;
    for (const line of (await obj.text()).split('\n')) {
      if (!line) continue;
      let m: LogQueueMessage;
      try {
        m = JSON.parse(line) as LogQueueMessage;
      } catch {
        continue;
      }
      const t = Date.parse(m.entry.timestamp);
      if (`${m.product_id}.${m.environment}` !== input.productEnvId) continue;
      if (t < input.from || t >= input.to) continue;
      if (input.level && m.entry.level !== input.level) continue;
      if (input.requestId && m.entry.request_id !== input.requestId && m.ingest_request_id !== input.requestId) continue;
      out.push({ received_at: m.received_at, source: m.source, ingest_request_id: m.ingest_request_id, entry: m.entry });
    }
  }
  out.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
  return out.slice(0, limit);
}
