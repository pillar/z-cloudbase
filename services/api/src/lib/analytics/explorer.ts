import { ApiError, type ExplorerEvent, type ExplorerResult } from '@z-cloudbase/contracts';
import type { Filter } from './dimensions.ts';
import { DAY_MS } from './range.ts';

export interface ExplorerInput {
  productEnvId: string;
  fromDay: number;
  toDay: number;
  event?: string | undefined;
  /** `user_key`, or `anon:<anonymous_id>` (the actor ids of the funnel / retention store). */
  actor?: string | undefined;
  filters: Filter[];
  /** Cursor `<occurred_at ms>:<event_id>` from the previous page. */
  before?: string | undefined;
  limit: number;
}

interface Row {
  event_id: string; event_name: string; user_key: string | null; anonymous_id: string | null; session_id: string | null;
  occurred_at: number; received_at: number; source: string; browser: string; os: string; device: string; country: string; path: string;
  dim1: string; dim2: string; dim3: string; dim_keys: string; properties: string | null; properties_truncated: number;
}

const parseJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s === null ? fallback : (JSON.parse(s) as T);
  } catch {
    return fallback;
  }
};

/** Recent events of one product environment, newest first (PRD §21.8 event explorer). */
export async function exploreEvents(db: D1Database, q: ExplorerInput): Promise<ExplorerResult> {
  const where = ['product_env_id = ?', 'occurred_at >= ?', 'occurred_at < ?'];
  const binds: unknown[] = [q.productEnvId, q.fromDay * DAY_MS, q.toDay * DAY_MS];
  if (q.event) (where.push('event_name = ?'), binds.push(q.event));
  if (q.actor) {
    if (q.actor.startsWith('anon:')) (where.push('user_key IS NULL AND anonymous_id = ?'), binds.push(q.actor.slice(5)));
    else (where.push('user_key = ?'), binds.push(q.actor));
  }
  for (const f of q.filters) (where.push(`${f.dim.column} = ?`), binds.push(f.value));
  if (q.before) {
    const at = q.before.indexOf(':');
    const ms = Number(q.before.slice(0, at));
    if (at <= 0 || !Number.isInteger(ms)) throw new ApiError('validation_failed', 'Invalid before cursor');
    where.push('(occurred_at < ? OR (occurred_at = ? AND event_id < ?))');
    binds.push(ms, ms, q.before.slice(at + 1));
  }
  const { results } = await db.prepare(
    `SELECT * FROM event_rows WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC, event_id DESC LIMIT ?`,
  ).bind(...binds, q.limit + 1).all<Row>();
  const page = results.slice(0, q.limit);
  const events: ExplorerEvent[] = page.map((r) => {
    const keys = parseJson<string[]>(r.dim_keys, []);
    const dims: Record<string, string> = {};
    keys.forEach((k, i) => (dims[k] = [r.dim1, r.dim2, r.dim3][i] ?? ''));
    return {
      event_id: r.event_id, event_name: r.event_name, occurred_at: new Date(r.occurred_at).toISOString(), received_at: new Date(r.received_at).toISOString(),
      user_key: r.user_key, anonymous_id: r.anonymous_id, session_id: r.session_id, source: r.source, browser: r.browser, os: r.os,
      device: r.device, country: r.country, path: r.path, dims,
      properties: parseJson<Record<string, unknown> | null>(r.properties, null), properties_truncated: r.properties_truncated === 1,
    };
  });
  const last = page.at(-1);
  const out: ExplorerResult = { events, next_before: results.length > q.limit && last ? `${last.occurred_at}:${last.event_id}` : null };
  if (q.actor && !q.actor.startsWith('anon:')) {
    const up = await db.prepare('SELECT properties FROM user_properties WHERE product_env_id = ? AND user_key = ?')
      .bind(q.productEnvId, q.actor).first<{ properties: string }>();
    out.user_properties = up ? parseJson<Record<string, unknown> | null>(up.properties, null) : null;
  }
  return out;
}
