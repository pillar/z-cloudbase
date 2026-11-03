// Admin API: audit query, usage estimate, analytics summary, log search.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, errorCode, initApp, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), searchLogs: vi.fn() }));
vi.mock('../src/identity.ts', () => ({ identity: () => ({ getJwks: async () => (globalThis as any).__testJwks }) }));
vi.mock('../src/lib/analytics/index.ts', () => ({ analyticsQuery: () => ({ summary: mocks.summary }) }));
vi.mock('../src/lib/logsearch/index.ts', () => ({ searchLogs: mocks.searchLogs }));

let w: World;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('ins');
});
beforeEach(() => {
  mocks.summary.mockReset().mockResolvedValue({ daily: [], events_total: 42, top_events: [], source: 'd1_substitute' });
  mocks.searchLogs.mockReset().mockResolvedValue([]);
});

async function audit(action: string, productId: string | null, at: number) {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, actor_type, actor_id, action, product_id, metadata) VALUES (?, ?, 'user', 'usr_x', ?, ?, ?)`,
  ).bind(`aud_${action}`, at, action, productId, JSON.stringify({ n: at })).run();
}

describe('GET /audit', () => {
  beforeAll(async () => {
    await audit('test.a1', w.a, 1_000);
    await audit('test.a2', w.a, 2_000);
    await audit('test.b1', w.b, 1_500);
    await audit('test.platform', null, 1_700);
  });

  it('returns a product trail newest first, filtered by time', async () => {
    const all = ((await (await api(w.tok.adminA, 'GET', `/audit?product_id=${w.a}`)).json()) as Json).entries as Json[];
    expect(all.filter((e) => e.action.startsWith('test.')).map((e) => e.action)).toEqual(['test.a2', 'test.a1']);
    expect(all.every((e) => e.product_id === w.a)).toBe(true);
    expect(all[0]!.metadata).toBeTypeOf('object');

    const ranged = ((await (await api(w.tok.adminA, 'GET', `/audit?product_id=${w.a}&from=${new Date(1500).toISOString()}&to=${new Date(2500).toISOString()}`)).json()) as Json).entries;
    expect(ranged.map((e: Json) => e.action)).toEqual(['test.a2']);
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/audit?product_id=${w.a}&from=yesterday`))).toBe('validation_failed');
  });

  it('platform-wide trail is for owner/operator; product admins and developers only get their own product', async () => {
    for (const t of [w.tok.owner, w.tok.operator]) {
      const entries = ((await (await api(t, 'GET', '/audit?limit=500')).json()) as Json).entries as Json[];
      const products = new Set(entries.map((e) => e.product_id));
      expect([products.has(w.a), products.has(w.b), products.has(null)]).toEqual([true, true, true]);
    }
    expect(await errorCode(await api(w.tok.adminA, 'GET', '/audit'))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/audit?product_id=${w.b}`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/audit?product_id=${w.a}`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'GET', `/audit?product_id=${w.a}`))).toBe('forbidden');
  });
});

describe('GET /products/:id/usage', () => {
  it('reports storage from available objects only, with events labelled as an estimate', async () => {
    const put = (id: string, envId: string, size: number, status: string) =>
      env.DB.prepare(
        `INSERT INTO storage_objects (id, product_env_id, bucket, object_key, filename, content_type, size, status, created_at) VALUES (?, ?, 'b', ?, 'f', 'text/plain', ?, ?, ?)`,
      ).bind(id, envId, `key/${id}`, size, status, Date.now()).run();
    await put('obj_a1', w.envs.a.prod, 1000, 'available');
    await put('obj_a2', w.envs.a.prod, 500, 'available');
    await put('obj_a3', w.envs.a.prod, 9999, 'pending');
    await put('obj_a4', w.envs.a.prod, 9999, 'deleted');
    await put('obj_b1', w.envs.b.prod, 7777, 'available');

    const body = (await (await api(w.tok.adminA, 'GET', `/products/${w.a}/usage?env=prod`)).json()) as Json;
    expect(body.estimate).toBe(true);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0]).toMatchObject({
      env: 'prod',
      storage: { bytes: 1500, objects: 2, quota_bytes: 5 * 1024 ** 3 },
      events: { total: 42, source: 'd1_substitute' },
    });
    expect(mocks.summary.mock.calls[0]![0].productEnvId).toBe(w.envs.a.prod);

    const everything = ((await (await api(w.tok.operator, 'GET', `/products/${w.a}/usage`)).json()) as Json).usage;
    expect(everything.map((u: Json) => u.env).sort()).toEqual(['dev', 'prod', 'staging']);
  });

  it('still reports storage when the analytics backend fails', async () => {
    mocks.summary.mockRejectedValue(new Error('AE down'));
    const body = (await (await api(w.tok.adminA, 'GET', `/products/${w.a}/usage?env=prod`)).json()) as Json;
    expect(body.usage[0].storage.bytes).toBe(1500);
    expect(body.usage[0].events).toBeNull();
  });

  it('is isolated per product', async () => {
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/usage`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.b}/usage`))).toBe('forbidden');
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});

describe('GET /products/:id/analytics', () => {
  it('passes the product env and range to the analytics backend and returns its summary', async () => {
    const res = await api(w.tok.devA, 'GET', `/products/${w.a}/analytics?env=dev&from=2026-10-01&to=2026-10-08`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).events_total).toBe(42);
    expect(mocks.summary).toHaveBeenCalledWith({ productEnvId: w.envs.a.dev, from: '2026-10-01', to: '2026-10-08' });
  });

  it('defaults the range and validates input', async () => {
    expect((await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics?env=prod`)).status).toBe(200);
    const { from, to } = mocks.summary.mock.calls[0]![0];
    expect(from < to).toBe(true);
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics`))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics?env=prod&from=2026-10-08&to=2026-10-01`))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/analytics?env=prod&from=notadate`))).toBe('validation_failed');
  });

  it('never queries another product\'s environment', async () => {
    mocks.summary.mockClear();
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/analytics?env=prod`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.b}/analytics?env=prod`))).toBe('forbidden');
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});

describe('GET /products/:id/logs', () => {
  it('searches within the product environment with request_id and level filters', async () => {
    const rec = [{ received_at: 'x', source: 'server', ingest_request_id: 'req_1', entry: { level: 'error', message: 'boom' } }];
    mocks.searchLogs.mockResolvedValue(rec);
    const res = await api(w.tok.operator, 'GET', `/products/${w.a}/logs?env=prod&request_id=req_abc&level=error&from=2026-10-08T00:00:00Z&to=2026-10-08T01:00:00Z`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).logs).toEqual(rec);
    expect(mocks.searchLogs.mock.calls[0]![1]).toEqual({
      productEnvId: w.envs.a.prod, from: Date.parse('2026-10-08T00:00:00Z'), to: Date.parse('2026-10-08T01:00:00Z'),
      limit: 100, requestId: 'req_abc', level: 'error',
    });
  });

  it('validates input and enforces product isolation', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/logs`))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/logs?env=prod&level=loud`))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.a}/logs?env=prod&from=2026-10-08T02:00:00Z&to=2026-10-08T01:00:00Z`))).toBe('validation_failed');
    mocks.searchLogs.mockClear();
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/logs?env=prod`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.b}/logs?env=prod`))).toBe('forbidden');
    expect(mocks.searchLogs).not.toHaveBeenCalled();
    expect(await errorCode(await api(w.tok.owner, 'GET', '/products/ins_missing/logs?env=prod'))).toBe('not_found');
  });
});
