// Admin analytics (PRD §21.8, §21.9): funnel, retention, breakdown, explorer, settings, export — semantics,
// RBAC and cross-product isolation for every route. Data is seeded straight into the ingest tables the
// consumer writes (the consumer itself is covered in services/consumer/test/analytics-store.test.ts).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, auditRows, errorCode, initApp, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';
import { archivePrefix, csvCell } from '../src/lib/analytics/export.ts';

vi.mock('../src/identity.ts', () => ({ identity: () => ({ getJwks: async () => (globalThis as any).__testJwks }) }));

const DAY = 24 * 3600 * 1000;
const today = Math.floor(Date.now() / DAY);
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const t = (day: number, h: number, m = 0) => day * DAY + (h * 60 + m) * 60_000;
const D5 = today - 5;
const D4 = today - 4;
const D3 = today - 3;

let w: World;
const get = async (tok: string, path: string) => {
  const res = await api(tok, 'GET', path);
  return { status: res.status, body: (await res.json()) as Json };
};

/** One occurrence → actor_daily / actors / event_rows, merged like the consumer does. */
async function occur(productEnvId: string, actor: string, event: string, at: number, dims: Record<string, string> = {}) {
  const day = Math.floor(at / DAY);
  await env.INGEST_DB.batch([
    env.INGEST_DB.prepare(
      `INSERT INTO actor_daily (product_env_id, event_name, day, actor, first_at, last_at, n, dims) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT DO UPDATE SET dims = CASE WHEN excluded.first_at < actor_daily.first_at THEN excluded.dims ELSE actor_daily.dims END,
         first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at), n = n + 1`,
    ).bind(productEnvId, event, day, actor, at, at, JSON.stringify(dims)),
    env.INGEST_DB.prepare(
      `INSERT INTO actors (product_env_id, actor, first_day, last_day) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET first_day = min(first_day, excluded.first_day), last_day = max(last_day, excluded.last_day)`,
    ).bind(productEnvId, actor, day, day),
    env.INGEST_DB.prepare(
      `INSERT INTO event_rows (product_env_id, event_id, event_name, user_key, anonymous_id, occurred_at, received_at, source, country, path, dim1, dim_keys, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, ?, '["plan"]', ?)`,
    ).bind(productEnvId, crypto.randomUUID(), event, actor.startsWith('anon:') ? null : actor, actor.startsWith('anon:') ? actor.slice(5) : null,
      at, at, dims.country ?? '', dims.path ?? '', dims['prop:plan'] ?? '', JSON.stringify({ path: dims.path ?? '' })),
  ]);
}

beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('an');
  const A = w.envs.a.prod;
  // Funnel view → signup → buy, 1-day window.
  await occur(A, 'u1', 'view', t(D5, 10), { country: 'DE', path: '/home' });
  await occur(A, 'u1', 'signup', t(D5, 10, 30));
  await occur(A, 'u1', 'buy', t(D5, 11));
  await occur(A, 'u1', 'view', t(D4, 9), { country: 'DE' });
  await occur(A, 'u2', 'view', t(D5, 10), { country: 'US', path: '/home' });
  await occur(A, 'u2', 'signup', t(D4, 9)); // 23 h later: inside the window
  await occur(A, 'u2', 'view', t(D3, 9), { country: 'US' });
  await occur(A, 'u3', 'view', t(D5, 10), { country: 'US', path: '/docs' });
  await occur(A, 'u3', 'signup', t(D3, 12)); // 2 days later: outside
  await occur(A, 'u4', 'signup', t(D5, 9)); // before its first view, same day only: no conversion
  await occur(A, 'u4', 'view', t(D5, 10), { country: 'US', path: '/home' });
  await env.INGEST_DB.prepare(`INSERT INTO user_properties (product_env_id, user_key, properties, updated_at) VALUES (?, 'u2', '{"plan":"pro","beta":true}', 0)`).bind(A).run();
  // Product B: a complete funnel that must never show up in A.
  for (const [e, h] of [['view', 10], ['signup', 11], ['buy', 12]] as const) await occur(w.envs.b.prod, 'secret_b_user', e, t(D5, h), { country: 'FR' });
});

const range = `from=${iso(D5)}&to=${iso(today + 1)}`;

describe('funnel', () => {
  it('counts sequential first occurrences within the window, scoped to the product env', async () => {
    const r = await get(w.tok.adminA, `/products/${w.a}/analytics/funnel?env=prod&${range}&steps=view,signup,buy&window=86400`);
    expect(r.status).toBe(200);
    expect(r.body.steps).toEqual([
      { event: 'view', actors: 4, conversion: 1 },
      { event: 'signup', actors: 2, conversion: 0.5 },
      { event: 'buy', actors: 1, conversion: 0.25 },
    ]);
  });

  it('filters the first step by a dimension and cohorts by a user property', async () => {
    const de = await get(w.tok.adminA, `/products/${w.a}/analytics/funnel?env=prod&${range}&steps=view,signup&filter=country:DE`);
    expect(de.body.steps.map((s: Json) => s.actors)).toEqual([1, 1]);
    const pro = await get(w.tok.adminA, `/products/${w.a}/analytics/funnel?env=prod&${range}&steps=view&steps=signup&user_property=plan:pro`);
    expect(pro.body.steps.map((s: Json) => s.actors)).toEqual([1, 1]);
    const beta = await get(w.tok.adminA, `/products/${w.a}/analytics/funnel?env=prod&${range}&steps=view,signup&user_property=beta:true`);
    expect(beta.body.steps.map((s: Json) => s.actors)).toEqual([1, 1]);
  });

  it('validates steps, window and filters', async () => {
    for (const q of ['steps=view', 'steps=a,b,c,d,e,f', 'steps=View,signup', 'steps=view,signup&window=99999999', 'steps=view,signup&filter=prop:undeclared:x', 'steps=view,signup&filter=event_name:view']) {
      expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/funnel?env=prod&${q}`))).toBe('validation_failed');
    }
  });
});

describe('retention', () => {
  it('first-seen daily cohorts with per-period returning actors', async () => {
    const r = await get(w.tok.adminA, `/products/${w.a}/analytics/retention?env=prod&from=${iso(D5)}&to=${iso(D4)}&periods=3`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ granularity: 'day', periods: 3, cohorts: [{ cohort: iso(D5), size: 4, retained: [4, 2, 2] }] });
  });

  it('start / return events and weekly granularity', async () => {
    const r = await get(w.tok.adminA, `/products/${w.a}/analytics/retention?env=prod&from=${iso(D5)}&to=${iso(D4)}&periods=3&start_event=signup&return_event=view`);
    // signup on D5: u1, u4 (u2, u3 signed up later). u1 viewed on D5 and D4; u4 on D5.
    expect(r.body.cohorts).toEqual([{ cohort: iso(D5), size: 2, retained: [2, 1, 0] }]);
    const wk = await get(w.tok.adminA, `/products/${w.a}/analytics/retention?env=prod&${range}&granularity=week&periods=2`);
    expect(wk.body.granularity).toBe('week');
    expect(wk.body.cohorts.reduce((n: number, c: Json) => n + c.size, 0)).toBe(4);
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/retention?env=prod&periods=40`))).toBe('validation_failed');
  });
});

describe('breakdown and explorer', () => {
  it('breaks events down by a dimension with filters (D1 substitute locally)', async () => {
    const r = await get(w.tok.adminA, `/products/${w.a}/analytics/breakdown?env=prod&${range}&by=country&event=view`);
    expect(r.body.source).toBe('d1_substitute');
    expect(r.body.rows).toEqual([{ value: 'US', events: 4, users: 3 }, { value: 'DE', events: 2, users: 1 }]);
    const f = await get(w.tok.adminA, `/products/${w.a}/analytics/breakdown?env=prod&${range}&by=path&filter=country:US`);
    expect(f.body.rows.find((x: Json) => x.value === '/home')).toEqual({ value: '/home', events: 2, users: 2 });
    expect(JSON.stringify(f.body)).not.toContain('FR');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/breakdown?env=prod&by=ip`))).toBe('validation_failed');
  });

  it('lists recent events newest first with a cursor, actor filter and that user\'s properties', async () => {
    const p1 = await get(w.tok.adminA, `/products/${w.a}/analytics/events?env=prod&${range}&limit=5`);
    expect(p1.body.events).toHaveLength(5);
    const times = p1.body.events.map((e: Json) => e.occurred_at);
    expect([...times].sort().reverse()).toEqual(times);
    const p2 = await get(w.tok.adminA, `/products/${w.a}/analytics/events?env=prod&${range}&limit=5&before=${encodeURIComponent(p1.body.next_before)}`);
    const p3 = await get(w.tok.adminA, `/products/${w.a}/analytics/events?env=prod&${range}&limit=5&before=${encodeURIComponent(p2.body.next_before)}`);
    expect(p3.body.next_before).toBeNull();
    const ids = [...p1.body.events, ...p2.body.events, ...p3.body.events].map((e: Json) => e.event_id);
    expect(new Set(ids).size).toBe(11);
    const u2 = await get(w.tok.adminA, `/products/${w.a}/analytics/events?env=prod&${range}&actor=u2`);
    expect(u2.body.events.map((e: Json) => e.event_name).sort()).toEqual(['signup', 'view', 'view']);
    expect(u2.body.user_properties).toEqual({ plan: 'pro', beta: true });
    const us = await get(w.tok.adminA, `/products/${w.a}/analytics/events?env=prod&${range}&event=view&filter=country:US`);
    expect(us.body.events).toHaveLength(4);
    expect(JSON.stringify(p1.body) + JSON.stringify(p2.body) + JSON.stringify(p3.body)).not.toContain('secret_b_user');
  });
});

describe('settings', () => {
  it('declares custom dimensions (product admins only, audited) used by breakdown', async () => {
    expect((await get(w.tok.devA, `/products/${w.a}/analytics/settings?env=prod`)).body).toEqual({ dimensions: [], retention_days: 90, archive_retention_days: 90 });
    expect(await errorCode(await api(w.tok.devA, 'PUT', `/products/${w.a}/analytics/settings?env=prod`, { dimensions: ['plan'] }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'PUT', `/products/${w.a}/analytics/settings?env=prod`, { dimensions: ['a', 'b', 'c', 'd'] }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'PUT', `/products/${w.a}/analytics/settings?env=prod`, { dimensions: ['a b'] }))).toBe('validation_failed');
    const put = await api(w.tok.adminA, 'PUT', `/products/${w.a}/analytics/settings?env=prod`, { dimensions: ['plan'] });
    expect(put.status).toBe(200);
    expect((await auditRows('analytics.settings_updated', w.a)).at(-1)).toMatchObject({ env: 'prod', actor_id: w.users.adminA });
    const r = await get(w.tok.adminA, `/products/${w.a}/analytics/breakdown?env=prod&${range}&by=prop:plan`);
    expect(r.status).toBe(200);
    // Other environments are unaffected.
    expect((await get(w.tok.adminA, `/products/${w.a}/analytics/settings?env=dev`)).body.dimensions).toEqual([]);
  });
});

describe('export (PRD §21.9)', () => {
  const gz = async (lines: unknown[]) =>
    new Response(new Blob([lines.map((l) => JSON.stringify(l)).join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const line = (id: string, userKey: string | null, props: Record<string, unknown> = {}) => ({
    event_id: id, event_name: 'view', occurred_at: new Date(t(D5, 10)).toISOString(), received_at: new Date(t(D5, 10)).toISOString(),
    user_key: userKey, anonymous_id: null, session_id: null, schema_version: 1, properties: props,
    context: { source: 'client', browser: 'chrome', os: 'macos', device: 'desktop', country: 'DE' },
  });

  beforeAll(async () => {
    const pre = archivePrefix(D5, w.a, 'prod');
    await env.ARCHIVE.put(`${pre}one.ndjson.gz`, await gz([line('e1', 'u1', { note: '=HYPERLINK("x")' }), line('e2', 'deleted_user')]));
    await env.ARCHIVE.put(`${pre}two.ndjson.gz`, await gz([line('e1', 'u1', { note: '=HYPERLINK("x")' }), line('e3', null)])); // e1 redelivered in another object
    await env.ARCHIVE.put(`${archivePrefix(D5, w.b, 'prod')}b.ndjson.gz`, await gz([line('secret_b', 'b1')]));
    await env.ARCHIVE.put(`${archivePrefix(D5, w.a, 'dev')}d.ndjson.gz`, await gz([line('dev1', null)]));
    await env.INGEST_DB.prepare(`INSERT INTO archive_suppressions (product_env_id, user_key, created_at) VALUES (?, 'deleted_user', ?)`).bind(w.envs.a.prod, Date.now()).run();
  });
  const exportUrl = (p: string, e: string, fmt = 'ndjson') => `/products/${p}/analytics/export?env=${e}&from=${iso(D5)}&to=${iso(D4)}&format=${fmt}`;

  it('streams NDJSON de-duplicated by event_id, without suppressed (deleted) users, and audits the export', async () => {
    const res = await api(w.tok.adminA, 'GET', exportUrl(w.a, 'prod'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`${w.a}-prod-events-`);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event_id).sort()).toEqual(['e1', 'e3']);
    expect((await auditRows('analytics.exported', w.a)).at(-1)).toMatchObject({ env: 'prod', actor_id: w.users.adminA });
  });

  it('CSV has a header and neutralises spreadsheet formulas', async () => {
    const text = await (await api(w.tok.owner, 'GET', exportUrl(w.a, 'prod', 'csv'))).text();
    const [header, ...rows] = text.trim().split('\n');
    expect(header).toBe('event_id,event_name,occurred_at,received_at,user_key,anonymous_id,session_id,source,browser,os,device,country,properties');
    expect(rows).toHaveLength(2);
    expect(text).not.toContain('deleted_user');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('{"note":"=X"}')).toBe('"{""note"":""=X""}"');
  });

  it('developers export only outside prod; operators never; other products are refused', async () => {
    expect(await errorCode(await api(w.tok.devA, 'GET', exportUrl(w.a, 'prod')))).toBe('forbidden');
    const dev = await api(w.tok.devA, 'GET', exportUrl(w.a, 'dev'));
    expect(dev.status).toBe(200);
    expect(await dev.text()).toContain('dev1');
    expect(await errorCode(await api(w.tok.operator, 'GET', exportUrl(w.a, 'dev')))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', exportUrl(w.b, 'prod')))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'GET', exportUrl(w.a, 'prod')))).toBe('forbidden');
  });

  it('limits the range', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/export?env=prod&from=${iso(today - 40)}&to=${iso(today)}`))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/export?env=prod`))).toBe('validation_failed');
  });
});

describe('isolation and RBAC on every analytics route', () => {
  const routes = [
    'funnel?env=prod&steps=view,signup', 'retention?env=prod', 'breakdown?env=prod&by=country', 'events?env=prod', 'settings?env=prod',
    `export?env=prod&from=${iso(D5)}&to=${iso(D4)}`,
  ];

  it("B's admin, a non-member and a product token get 403/401 for A; reading B never shows A's data", async () => {
    for (const r of routes) {
      expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/analytics/${r}`))).toBe('forbidden');
      expect(await errorCode(await api(w.tok.nobody, 'GET', `/products/${w.a}/analytics/${r}`))).toBe('forbidden');
      expect((await api(w.tok.product, 'GET', `/products/${w.a}/analytics/${r}`)).status).toBe(401);
      const own = await api(w.tok.adminB, 'GET', `/products/${w.b}/analytics/${r}`);
      expect(own.status).toBe(200);
      expect(await own.text()).not.toMatch(/\bu1\b|\bu2\b|"e1"/);
    }
    expect(await errorCode(await api(w.tok.adminB, 'PUT', `/products/${w.a}/analytics/settings?env=prod`, { dimensions: [] }))).toBe('forbidden');
  });

  it('missing env is a validation error and an unknown product is 404 for the owner', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics/funnel?steps=a,b`))).toBe('validation_failed');
    for (const r of routes) expect(await errorCode(await api(w.tok.owner, 'GET', `/products/an_missing/analytics/${r}`))).toBe('not_found');
  });
});
