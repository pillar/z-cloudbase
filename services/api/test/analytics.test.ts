// AnalyticsQuery: D1 substitute (local) and the Analytics Engine SQL client (remote-unverified).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { aeAnalyticsQuery, analyticsQuery, d1AnalyticsQuery } from '../src/lib/analytics/index.ts';

const DAY = 24 * 3600 * 1000;
const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
let n = 0;
const insert = (productEnvId: string, name: string, occurredAt: number, who: { user?: string; anon?: string }) =>
  env.INGEST_DB.prepare(
    'INSERT INTO events_substitute (product_env_id, event_id, event_name, user_key, anonymous_id, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(productEnvId, `e${n++}`, name, who.user ?? null, who.anon ?? null, occurredAt, occurredAt).run();

describe('D1 substitute AnalyticsQuery', () => {
  it('summarises per UTC day with distinct users / anonymous visitors and top events, only for the asked product', async () => {
    await insert('an_a.prod', 'page_view', at('2026-03-01'), { user: 'u1' });
    await insert('an_a.prod', 'page_view', at('2026-03-01', 23), { user: 'u1' });
    await insert('an_a.prod', 'signup', at('2026-03-01'), { user: 'u2', anon: 'dev-1' }); // user_key present: not an anonymous visitor
    await insert('an_a.prod', 'page_view', at('2026-03-01'), { anon: 'dev-1' });
    await insert('an_a.prod', 'page_view', at('2026-03-01'), { anon: 'dev-1' });
    await insert('an_a.prod', 'page_view', at('2026-03-03'), { anon: 'dev-2' });
    await insert('an_a.prod', 'page_view', at('2026-03-05'), { user: 'u9' }); // outside [from, to)
    await insert('an_b.prod', 'page_view', at('2026-03-01'), { user: 'b1' }); // other product
    await insert('an_a.dev', 'page_view', at('2026-03-01'), { user: 'd1' }); // other environment

    const s = await d1AnalyticsQuery(env.INGEST_DB).summary({ productEnvId: 'an_a.prod', from: '2026-03-01', to: '2026-03-04' });
    expect(s.source).toBe('d1_substitute');
    expect(s.daily).toEqual([
      { day: '2026-03-01', users: 2, anonymous: 1, events: 5 },
      { day: '2026-03-02', users: 0, anonymous: 0, events: 0 },
      { day: '2026-03-03', users: 0, anonymous: 1, events: 1 },
    ]);
    expect(s.events_total).toBe(6);
    expect(s.top_events).toEqual([{ name: 'page_view', count: 5 }, { name: 'signup', count: 1 }]);
  });

  it("does not leak another product's events and returns zeros for an unknown product", async () => {
    await insert('an_c.prod', 'secret_event', at('2026-04-01'), { user: 'c1' });
    const other = await d1AnalyticsQuery(env.INGEST_DB).summary({ productEnvId: 'an_d.prod', from: '2026-04-01', to: '2026-04-02' });
    expect(other.events_total).toBe(0);
    expect(other.top_events).toEqual([]);
    expect(JSON.stringify(other)).not.toContain('secret_event');
  });

  it('clamps the range to the 90-day query window', async () => {
    const now = Date.now();
    const to = new Date(now).toISOString().slice(0, 10);
    const s = await d1AnalyticsQuery(env.INGEST_DB).summary({ productEnvId: 'an_a.prod', from: new Date(now - 400 * DAY).toISOString(), to });
    expect(s.daily).toHaveLength(90);
  });

  it('is chosen for local and test deploys; other deploys need Analytics Engine credentials', async () => {
    const local = await analyticsQuery(env).summary({ productEnvId: 'an_a.prod', from: '2026-03-01', to: '2026-03-02' });
    expect(local.source).toBe('d1_substitute');
    expect(() => analyticsQuery({ ...env, DEPLOY_ENV: 'production' } as unknown as typeof env)).toThrow(/credentials/);
    expect(() => analyticsQuery({ ...env, DEPLOY_ENV: 'staging', CF_ACCOUNT_ID: 'a', CF_ANALYTICS_API_TOKEN: 't', AE_DATASET: '' } as unknown as typeof env)).toThrow(/AE_DATASET/);
  });
});

describe('Analytics Engine SQL AnalyticsQuery (fake fetch; remote-unverified)', () => {
  const fakeAe = (rows: { daily: unknown[]; top: unknown[] }, status = 200) => {
    const calls: Array<{ url: string; auth: string | null; sql: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const sql = String(init.body);
      calls.push({ url, auth: new Headers(init.headers).get('Authorization'), sql });
      // One query per figure: AE SQL has no uniqIf / uniq, only count(DISTINCT x).
      const pick = (col: string) => rows.daily.map((r) => ({ day: (r as any).day, [col]: (r as any)[col] }));
      const data = sql.includes('AS users') ? pick('users') : sql.includes('AS anonymous') ? pick('anonymous') : sql.includes('GROUP BY day') ? pick('events') : rows.top;
      return Response.json({ data }, { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it('queries the dataset scoped to the product env and maps the rows', async () => {
    const { calls, fetchFn } = fakeAe({
      daily: [{ day: '2026-03-01 00:00:00', events: '7', users: '2', anonymous: '1' }],
      top: [{ name: 'page_view', count: '7' }],
    });
    const s = await aeAnalyticsQuery({ accountId: 'acc1', apiToken: 'tok', dataset: 'z_cloudbase_staging_events', fetch: fetchFn })
      .summary({ productEnvId: 'an_a.prod', from: '2026-03-01', to: '2026-03-03' });
    expect(s).toEqual({
      daily: [{ day: '2026-03-01', users: 2, anonymous: 1, events: 7 }, { day: '2026-03-02', users: 0, anonymous: 0, events: 0 }],
      events_total: 7,
      top_events: [{ name: 'page_view', count: 7 }],
      source: 'analytics_engine',
    });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc1/analytics_engine/sql');
      expect(c.auth).toBe('Bearer tok');
      expect(c.sql).toContain("index1 = 'an_a.prod'");
      expect(c.sql).toContain('FROM z_cloudbase_staging_events ');
      // Functions the AE SQL API rejects (verified against staging: "unknown function call: UNIQIF").
      expect(c.sql).not.toMatch(/\buniq/i);
    }
  });

  it('refuses product ids that could alter the SQL, and surfaces API failures', async () => {
    const { fetchFn, calls } = fakeAe({ daily: [], top: [] });
    const ae = aeAnalyticsQuery({ accountId: 'acc1', apiToken: 'tok', fetch: fetchFn });
    await expect(ae.summary({ productEnvId: "x.prod' OR 1=1 --", from: '2026-03-01', to: '2026-03-02' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const failing = fakeAe({ daily: [], top: [] }, 500);
    await expect(aeAnalyticsQuery({ accountId: 'a', apiToken: 't', fetch: failing.fetchFn }).summary({ productEnvId: 'an_a.prod', from: '2026-03-01', to: '2026-03-02' }))
      .rejects.toThrow(/500/);
  });
});
