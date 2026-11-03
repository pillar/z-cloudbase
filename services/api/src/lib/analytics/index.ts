// Analytics read interface used by admin routes (owned by the ingest/consumer module).
// Production: Workers Analytics Engine SQL API. Local/test: D1 substitute (PRD §19.10).
import { ANALYTICS_QUERY_WINDOW_DAYS, parseClientId, type BreakdownResult } from '@z-cloudbase/contracts';
import { aeLiteralSafe, aeString, type Filter, type ResolvedDimension } from './dimensions.ts';
import { DAY_MS as DAY } from './range.ts';

export interface AnalyticsSummary {
  /** One row per UTC day in [from, to). `users` = distinct user_key, `anonymous` = distinct anonymous_id without user_key. */
  daily: Array<{ day: string; users: number; anonymous: number; events: number }>;
  events_total: number;
  top_events: Array<{ name: string; count: number }>;
  /** 'analytics_engine' in production, 'd1_substitute' locally — surfaced so results are never mistaken for AE. */
  source: 'analytics_engine' | 'd1_substitute';
}

export interface BreakdownInput {
  productEnvId: string;
  /** UTC day numbers, [fromDay, toDay); already clamped by the caller. */
  fromDay: number;
  toDay: number;
  by: ResolvedDimension;
  event?: string | undefined;
  filters: Filter[];
  limit: number;
}

export interface AnalyticsQuery {
  /** `from`/`to` are ISO dates; range is clamped to ANALYTICS_QUERY_WINDOW_DAYS. */
  summary(input: { productEnvId: string; from: string; to: string }): Promise<AnalyticsSummary>;
  /** Events and distinct signed-in users per value of one dimension (PRD §21.8). */
  breakdown(input: BreakdownInput): Promise<BreakdownResult>;
}

const DAY_MS = 24 * 3600 * 1000;
const TOP_EVENTS = 10;
const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Normalize the requested range to whole UTC days, clamped to the query window; `days` lists each day in [from, to). */
function resolveRange(from: string, to: string): { fromMs: number; toMs: number; days: string[] } {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) throw new RangeError('from/to must be ISO dates');
  const toMs = dayStart(t);
  const fromMs = Math.max(dayStart(f), toMs - ANALYTICS_QUERY_WINDOW_DAYS * DAY_MS);
  const days: string[] = [];
  for (let d = fromMs; d < toMs; d += DAY_MS) days.push(dayKey(d));
  return { fromMs, toMs, days };
}

/** Local / test implementation over the `event_rows` table filled by the consumer. */
export function d1AnalyticsQuery(db: D1Database): AnalyticsQuery {
  return {
    async summary({ productEnvId, from, to }) {
      const { fromMs, toMs, days } = resolveRange(from, to);
      const [daily, top] = await db.batch([
        db.prepare(
          `SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day, COUNT(*) AS events,
                  COUNT(DISTINCT user_key) AS users,
                  COUNT(DISTINCT CASE WHEN user_key IS NULL THEN anonymous_id END) AS anonymous
           FROM event_rows WHERE product_env_id = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY day`,
        ).bind(productEnvId, fromMs, toMs),
        db.prepare(
          `SELECT event_name AS name, COUNT(*) AS count FROM event_rows
           WHERE product_env_id = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY event_name ORDER BY count DESC, name LIMIT ?`,
        ).bind(productEnvId, fromMs, toMs, TOP_EVENTS),
      ]);
      const byDay = new Map((daily!.results as Array<{ day: string; events: number; users: number; anonymous: number }>).map((r) => [r.day, r]));
      const rows = days.map((day) => {
        const r = byDay.get(day);
        return { day, users: r?.users ?? 0, anonymous: r?.anonymous ?? 0, events: r?.events ?? 0 };
      });
      return {
        daily: rows,
        events_total: rows.reduce((n, r) => n + r.events, 0),
        top_events: top!.results as Array<{ name: string; count: number }>,
        source: 'd1_substitute',
      };
    },
    async breakdown(q) {
      const where = ['product_env_id = ?', 'occurred_at >= ?', 'occurred_at < ?'];
      const binds: unknown[] = [q.productEnvId, q.fromDay * DAY, q.toDay * DAY];
      if (q.event) (where.push('event_name = ?'), binds.push(q.event));
      for (const f of q.filters) (where.push(`${f.dim.column} = ?`), binds.push(f.value));
      const { results } = await db.prepare(
        `SELECT ${q.by.column} AS value, COUNT(*) AS events, COUNT(DISTINCT user_key) AS users FROM event_rows
         WHERE ${where.join(' AND ')} GROUP BY value ORDER BY events DESC, value LIMIT ?`,
      ).bind(...binds, q.limit).all<{ value: string; events: number; users: number }>();
      return { by: q.by.name, rows: results, source: 'd1_substitute' };
    },
  };
}

export interface AeConfig {
  accountId: string;
  apiToken: string;
  /** Dataset bound as EVENTS_AE in the consumer. */
  dataset?: string;
  fetch?: typeof fetch;
}

/**
 * Production implementation over the Analytics Engine SQL API.
 * Column mapping mirrors the consumer's writeDataPoint: index1 = product_env_id,
 * blob1 product_id, blob2 env, blob3 event_name, blob4 user_key, blob5 anonymous_id, blob6 path, blob7 browser,
 * blob8 os, blob9 device, blob10 country, blob11 source, blob12–14 custom dimensions (PRD §21.8).
 * REMOTE-UNVERIFIED: only exercised against a fake fetch locally (PRD §19.10).
 */
export function aeAnalyticsQuery(cfg: AeConfig): AnalyticsQuery {
  const dataset = cfg.dataset ?? 'z_cloudbase_events';
  const doFetch = cfg.fetch ?? fetch;
  async function sql<T>(query: string): Promise<T[]> {
    const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/analytics_engine/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
      body: query,
    });
    if (!res.ok) throw new Error(`Analytics Engine SQL API returned ${res.status}`);
    return ((await res.json()) as { data: T[] }).data;
  }
  return {
    async summary({ productEnvId, from, to }) {
      // productEnvId is interpolated into SQL: accept only the strict `{product}.{env}` shape.
      if (!parseClientId(productEnvId)) throw new RangeError('invalid productEnvId');
      const { fromMs, toMs, days } = resolveRange(from, to);
      const where = `index1 = '${productEnvId}' AND timestamp >= toDateTime('${dayKey(fromMs)} 00:00:00') AND timestamp < toDateTime('${dayKey(toMs)} 00:00:00')`;
      // AE SQL has no uniqIf / uniq (only count(DISTINCT x)), so each distinct count is its own filtered query.
      const perDay = (select: string, filter = '') =>
        sql<Record<string, string | number> & { day: string }>(
          `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, ${select}
           FROM ${dataset} WHERE ${where}${filter} GROUP BY day ORDER BY day FORMAT JSON`,
        );
      const [events, users, anonymous, top] = await Promise.all([
        perDay('sum(_sample_interval) AS events'),
        perDay('count(DISTINCT blob4) AS users', ` AND blob4 != ''`),
        perDay('count(DISTINCT blob5) AS anonymous', ` AND blob4 = '' AND blob5 != ''`),
        sql<{ name: string; count: string | number }>(
          `SELECT blob3 AS name, sum(_sample_interval) AS count FROM ${dataset} WHERE ${where}
           GROUP BY name ORDER BY count DESC LIMIT ${TOP_EVENTS} FORMAT JSON`,
        ),
      ]);
      const byDay = new Map<string, { events?: string | number; users?: string | number; anonymous?: string | number }>();
      for (const r of [...events, ...users, ...anonymous]) {
        const key = r.day.slice(0, 10);
        byDay.set(key, { ...byDay.get(key), ...r });
      }
      const rows = days.map((day) => {
        const r = byDay.get(day);
        return { day, users: Number(r?.users ?? 0), anonymous: Number(r?.anonymous ?? 0), events: Number(r?.events ?? 0) };
      });
      return {
        daily: rows,
        events_total: rows.reduce((n, r) => n + r.events, 0),
        top_events: top.map((r) => ({ name: r.name, count: Number(r.count) })),
        source: 'analytics_engine',
      };
    },
    async breakdown(q) {
      if (!parseClientId(q.productEnvId)) throw new RangeError('invalid productEnvId');
      const day = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
      let where = `index1 = '${q.productEnvId}' AND timestamp >= toDateTime('${day(q.fromDay)} 00:00:00') AND timestamp < toDateTime('${day(q.toDay)} 00:00:00')`;
      if (q.event) where += ` AND blob3 = ${aeString(q.event)}`;
      for (const f of q.filters) where += ` AND ${f.dim.ae} = ${aeString(f.value)}`;
      const events = await sql<{ value: string; events: string | number }>(
        `SELECT ${q.by.ae} AS value, sum(_sample_interval) AS events FROM ${dataset} WHERE ${where}
         GROUP BY value ORDER BY events DESC LIMIT ${q.limit} FORMAT JSON`,
      );
      // Distinct users only for the values shown (AE SQL has no JOIN; count(DISTINCT) on a blob is approximate under sampling).
      // The values come from end users' events: only plain literals are put into this query; the others get
      // `users: null` (unknown) rather than an escaped literal whose meaning AE does not document.
      const listed = events.map((r) => String(r.value)).filter(aeLiteralSafe);
      const users = listed.length === 0 ? [] : await sql<{ value: string; users: string | number }>(
        `SELECT ${q.by.ae} AS value, count(DISTINCT blob4) AS users FROM ${dataset} WHERE ${where} AND blob4 != ''
         AND ${q.by.ae} IN (${listed.map(aeString).join(', ')}) GROUP BY value FORMAT JSON`,
      );
      const u = new Map(users.map((r) => [r.value, Number(r.users)]));
      return {
        by: q.by.name,
        rows: events.map((r) => ({ value: r.value, events: Number(r.events), users: aeLiteralSafe(String(r.value)) ? u.get(r.value) ?? 0 : null })),
        source: 'analytics_engine',
      };
    },
  };
}

/** AE credentials are secrets (`wrangler secret put`), not part of the generated Env. */
type AeSecrets = { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };

/** Local / test deploys read the D1 substitute; every other DEPLOY_ENV reads Analytics Engine. */
export function analyticsQuery(env: Pick<Env, 'INGEST_DB' | 'DEPLOY_ENV'>): AnalyticsQuery {
  if (['local', 'test'].includes(env.DEPLOY_ENV as string)) return d1AnalyticsQuery(env.INGEST_DB);
  const { CF_ACCOUNT_ID, CF_ANALYTICS_API_TOKEN } = env as AeSecrets;
  if (!CF_ACCOUNT_ID || !CF_ANALYTICS_API_TOKEN) throw new Error('Analytics Engine credentials (CF_ACCOUNT_ID, CF_ANALYTICS_API_TOKEN) are not configured');
  // The dataset the consumer writes (its EVENTS_AE binding); deployments name it per environment.
  const dataset = (env as { AE_DATASET?: string }).AE_DATASET;
  if (!dataset) throw new Error('AE_DATASET is not configured');
  return aeAnalyticsQuery({ accountId: CF_ACCOUNT_ID, apiToken: CF_ANALYTICS_API_TOKEN, dataset });
}
