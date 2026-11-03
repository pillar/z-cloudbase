import type { FunnelResult, RetentionResult } from '@z-cloudbase/contracts';
import { userPropertyClause, type Filter, type UserPropertyFilter } from './dimensions.ts';
import { DAY_MS, dayString } from './range.ts';

// Funnels and retention over the per-actor store (PRD §21.8). Each query is one D1 statement whose every
// table access carries `product_env_id`, so another product's rows can never contribute.

export interface FunnelInput {
  productEnvId: string;
  steps: string[];
  fromDay: number;
  toDay: number;
  windowS: number;
  /** Applies to the first step: the day's first occurrence must match. */
  filter?: Filter | undefined;
  userProperty?: UserPropertyFilter | undefined;
}

/**
 * Sequential first-occurrence funnel: step 1 = first occurrence in [from, to); step k = earliest occurrence after
 * step k-1 and within t1 + window. Per day only first/last times are known, so an occurrence before t(k-1) on
 * the same day falls back to that day's last time (may undercount, never overcounts).
 */
export async function funnel(db: D1Database, q: FunnelInput): Promise<FunnelResult> {
  const w = q.windowS * 1000;
  const binds: unknown[] = [q.productEnvId, q.steps[0], q.fromDay, q.toDay];
  let s1Where = 'product_env_id = ? AND event_name = ? AND day >= ? AND day < ?';
  if (q.filter) {
    // Dimension names come from a closed set (resolveDimension); the value is bound.
    s1Where += ` AND json_extract(dims, '$."${q.filter.dim.name}"') = ?`;
    binds.push(q.filter.value);
  }
  if (q.userProperty) {
    const c = userPropertyClause(q.productEnvId, 'actor', q.userProperty);
    s1Where += ` AND ${c.sql}`;
    binds.push(...c.binds);
  }
  const ctes = [`s1 AS (SELECT actor, MIN(first_at) AS t1, MIN(first_at) AS t FROM actor_daily WHERE ${s1Where} GROUP BY actor)`];
  for (let k = 2; k <= q.steps.length; k++) {
    const at = 'CASE WHEN a.first_at > p.t THEN a.first_at ELSE a.last_at END';
    ctes.push(
      `s${k} AS (SELECT p.actor, p.t1, MIN(${at}) AS t FROM s${k - 1} p
        JOIN actor_daily a ON a.product_env_id = ? AND a.event_name = ? AND a.actor = p.actor
          AND a.day >= p.t / ${DAY_MS} AND a.day <= (p.t1 + ?) / ${DAY_MS} AND a.last_at > p.t
        WHERE ${at} <= p.t1 + ?
        GROUP BY p.actor, p.t1)`,
    );
    binds.push(q.productEnvId, q.steps[k - 1], w, w);
  }
  const select = q.steps.map((_, i) => `(SELECT COUNT(*) FROM s${i + 1}) AS c${i + 1}`).join(', ');
  const row = await db.prepare(`WITH ${ctes.join(',\n')} SELECT ${select}`).bind(...binds).first<Record<string, number>>();
  const first = row?.c1 ?? 0;
  return {
    steps: q.steps.map((event, i) => {
      const actors = row?.[`c${i + 1}`] ?? 0;
      return { event, actors, conversion: first === 0 ? 0 : actors / first };
    }),
    window_s: q.windowS,
    from: dayString(q.fromDay),
    to: dayString(q.toDay),
  };
}

export interface RetentionInput {
  productEnvId: string;
  granularity: 'day' | 'week';
  periods: number;
  fromDay: number;
  toDay: number;
  startEvent?: string | undefined;
  returnEvent?: string | undefined;
  userProperty?: UserPropertyFilter | undefined;
}

/** Monday-based week start of a UTC day number (day 0 = Thursday 1970-01-01). */
const weekStart = (expr: string) => `(${expr} - ((${expr} + 3) % 7))`;

/**
 * Cohorts by first-seen day (`actors.first_day`) or by the first occurrence of `startEvent` in range;
 * `retained[k]` = actors with `returnEvent` (any event when omitted) in period k after their cohort period.
 */
export async function retention(db: D1Database, q: RetentionInput): Promise<RetentionResult> {
  const g = q.granularity === 'week' ? 7 : 1;
  const period = (e: string) => (g === 7 ? weekStart(e) : e);
  const cohortBinds: unknown[] = [];
  let cohort: string;
  if (q.startEvent) {
    cohort = 'SELECT actor, MIN(day) AS d FROM actor_daily WHERE product_env_id = ? AND event_name = ? AND day >= ? AND day < ?';
    cohortBinds.push(q.productEnvId, q.startEvent, q.fromDay, q.toDay);
  } else {
    cohort = 'SELECT actor, first_day AS d FROM actors WHERE product_env_id = ? AND first_day >= ? AND first_day < ?';
    cohortBinds.push(q.productEnvId, q.fromDay, q.toDay);
  }
  if (q.userProperty) {
    const c = userPropertyClause(q.productEnvId, 'actor', q.userProperty);
    cohort += ` AND ${c.sql}`;
    cohortBinds.push(...c.binds);
  }
  if (q.startEvent) cohort += ' GROUP BY actor';

  const sizes = db.prepare(`WITH c AS (${cohort}) SELECT ${period('d')} AS p, COUNT(*) AS n FROM c GROUP BY p`).bind(...cohortBinds);
  const retBinds: unknown[] = [...cohortBinds, q.productEnvId];
  let returnCond = '';
  if (q.returnEvent) {
    returnCond = ' AND a.event_name = ?';
    retBinds.push(q.returnEvent);
  }
  retBinds.push(q.periods * g);
  const retained = db.prepare(
    `WITH c AS (${cohort})
     SELECT ${period('c.d')} AS p, (${period('a.day')} - ${period('c.d')}) / ${g} AS k, COUNT(DISTINCT c.actor) AS n
     FROM c JOIN actor_daily a ON a.product_env_id = ? AND a.actor = c.actor AND a.day >= c.d${returnCond}
       AND a.day < ${period('c.d')} + ?
     GROUP BY p, k`,
  ).bind(...retBinds);
  const [s, r] = await db.batch<{ p: number; n: number; k?: number }>([sizes, retained]);

  const byCohort = new Map<number, { size: number; retained: number[] }>();
  for (const row of s!.results) byCohort.set(row.p, { size: row.n, retained: new Array<number>(q.periods).fill(0) });
  for (const row of r!.results) {
    const c = byCohort.get(row.p);
    if (c && row.k! >= 0 && row.k! < q.periods) c.retained[row.k!] = row.n;
  }
  const cohorts = [...byCohort.entries()].sort(([a], [b]) => a - b).map(([p, c]) => ({ cohort: dayString(p), ...c }));
  return { granularity: q.granularity, periods: q.periods, cohorts };
}
