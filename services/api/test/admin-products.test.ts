// Admin API: product lifecycle (POST/GET/PATCH /v1/admin/products).
import { PUBLISHABLE_KEY_RE } from '@z-cloudbase/contracts';
import { errorHandler, requestId } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import type { AppEnv } from '../src/context.ts';
import { withCredential } from '../src/middleware/auth.ts';
import { api, auditRows, initApp, rawRequest, dbValue, errorCode, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

const rpc = vi.hoisted(() => ({ upsertProductClient: vi.fn(), revokeUserTokens: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));

let w: World;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('prd');
});
beforeEach(() => {
  rpc.upsertProductClient.mockReset().mockResolvedValue({ clientId: 'x', resource: 'y' });
});

describe('POST /products', () => {
  it('creates a product with three environments, syncs OIDC clients and audits', async () => {
    const res = await api(w.tok.owner, 'POST', '/products', {
      product_id: 'prd_new', name: 'New', redirect_uris: ['https://new.example/cb'], allowed_origins: ['https://new.example'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body.status).toBe('active');
    expect(body.environments.map((e: Json) => e.env)).toEqual(['dev', 'staging', 'prod']);
    for (const e of body.environments) {
      expect(e.id).toBe(`prd_new.${e.env}`);
      expect(e.publishable_key).toMatch(PUBLISHABLE_KEY_RE);
      expect(e.publishable_key.startsWith(`pk_${e.env}_`)).toBe(true);
      expect(e.storage_quota_bytes).toBe(5 * 1024 ** 3);
    }
    expect(rpc.upsertProductClient.mock.calls.map(([a]) => [a.productId, a.env, a.redirectUris, a.type])).toEqual(
      ['dev', 'staging', 'prod'].map((e) => ['prd_new', e, ['https://new.example/cb'], 'public']),
    );
    // Salts are per environment and never exposed through the API.
    const { results } = await env.DB.prepare("SELECT user_key_salt FROM product_environments WHERE product_id = 'prd_new'").all<Json>();
    expect(new Set(results.map((r) => r.user_key_salt)).size).toBe(3);
    expect(JSON.stringify(body)).not.toContain(results[0]!.user_key_salt);
    expect(await auditRows('product.create', 'prd_new')).toHaveLength(1);
  });

  it('rejects the reserved console id, duplicates and malformed bodies', async () => {
    const cb = { redirect_uris: ['https://x.example/cb'] };
    expect(await errorCode(await api(w.tok.owner, 'POST', '/products', { product_id: 'platform_console', name: 'x', ...cb }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/products', { product_id: 'Bad-Id', name: 'x', ...cb }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/products', { product_id: w.a, name: 'dup', ...cb }))).toBe('conflict');
    // Every environment is an OIDC client, which needs a redirect URI: a 400, not a failed identity call (500).
    for (const body of [{ product_id: 'prd_nocb', name: 'x' }, { product_id: 'prd_nocb', name: 'x', redirect_uris: [] }]) {
      expect(await errorCode(await api(w.tok.owner, 'POST', '/products', body))).toBe('validation_failed');
    }
    expect(rpc.upsertProductClient).not.toHaveBeenCalled();
    const notJson = await rawRequest('/products', { method: 'POST', headers: { Authorization: `Bearer ${w.tok.owner}` }, body: '{' });
    expect(await errorCode(notJson)).toBe('invalid_request');
    expect(await dbValue('SELECT 1 AS x FROM products WHERE id = ?', 'platform_console')).toBeNull();
  });

  it('creates nothing when the identity worker fails', async () => {
    rpc.upsertProductClient.mockRejectedValueOnce(new Error('identity down'));
    expect((await api(w.tok.owner, 'POST', '/products', { product_id: 'prd_fail', name: 'x', redirect_uris: ['https://x.example/cb'] })).status).toBe(500);
    expect(await dbValue('SELECT 1 AS x FROM products WHERE id = ?', 'prd_fail')).toBeNull();
  });

  it('is limited to the platform owner', async () => {
    for (const t of [w.tok.operator, w.tok.adminA, w.tok.devA]) {
      expect(await errorCode(await api(t, 'POST', '/products', { product_id: 'prd_nope', name: 'x' }))).toBe('forbidden');
    }
    expect(await dbValue('SELECT 1 AS x FROM products WHERE id = ?', 'prd_nope')).toBeNull();
  });
});

describe('GET /products', () => {
  const ids = async (t: string) => ((await (await api(t, 'GET', '/products')).json()) as Json).products.map((p: Json) => p.id) as string[];

  it('lists only the products the principal may see', async () => {
    expect(await ids(w.tok.adminA)).toEqual([w.a]);
    expect(await ids(w.tok.devA)).toEqual([w.a]);
    expect(await ids(w.tok.adminB)).toEqual([w.b]);
    expect(await ids(w.tok.owner)).toEqual(expect.arrayContaining([w.a, w.b]));
    expect(await ids(w.tok.operator)).toEqual(expect.arrayContaining([w.a, w.b]));
  });

  it('GET /products/:id returns details to the team and 403 to everyone else, including for unknown ids', async () => {
    const own = (await (await api(w.tok.adminA, 'GET', `/products/${w.a}`)).json()) as Json;
    expect(own.id).toBe(w.a);
    expect(own.environments).toHaveLength(3);
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.b}`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', '/products/prd_missing'))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.owner, 'GET', '/products/prd_missing'))).toBe('not_found');
  });
});

describe('PATCH /products/:id', () => {
  it('lets a product admin edit settings and re-syncs every environment when redirect URIs change', async () => {
    const res = await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, { name: 'Renamed', redirect_uris: ['https://a.example/cb'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).redirect_uris).toEqual(['https://a.example/cb']);
    expect(rpc.upsertProductClient).toHaveBeenCalledTimes(3);
    expect(rpc.upsertProductClient.mock.calls.every(([a]) => a.productId === w.a && a.redirectUris[0] === 'https://a.example/cb')).toBe(true);
    expect((await dbValue<{ name: string }>('SELECT name FROM products WHERE id = ?', w.a))!.name).toBe('Renamed');
    expect(await auditRows('product.update', w.a)).toHaveLength(1);
  });

  it('does not touch the database when the OIDC re-sync fails', async () => {
    rpc.upsertProductClient.mockRejectedValue(new Error('identity down'));
    const res = await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, { name: 'Should not apply', redirect_uris: ['https://z.example/cb'] });
    expect(res.status).toBe(500);
    expect((await dbValue<{ name: string }>('SELECT name FROM products WHERE id = ?', w.a))!.name).not.toBe('Should not apply');
  });

  it('validates input', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, {}))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, { redirect_uris: ['not a url'] }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, { redirect_uris: [] }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'PATCH', '/products/prd_missing', { name: 'x' }))).toBe('not_found');
  });

  it('rejects writes from developers and operators', async () => {
    for (const t of [w.tok.devA, w.tok.operator]) {
      expect(await errorCode(await api(t, 'PATCH', `/products/${w.a}`, { name: 'hacked' }))).toBe('forbidden');
    }
  });

  it('keeps status changes with the platform owner and they bite on the very next credential check', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', `/products/${w.a}`, { status: 'disabled' }))).toBe('forbidden');
    expect((await dbValue<{ status: string }>('SELECT status FROM products WHERE id = ?', w.a))!.status).toBe('active');

    const pk = (await dbValue<{ publishable_key: string }>('SELECT publishable_key FROM product_environments WHERE id = ?', w.envs.a.prod))!.publishable_key;
    const probe = new Hono<AppEnv>();
    probe.use(requestId());
    probe.onError(errorHandler);
    probe.get('/probe', withCredential({ allow: ['publishable'] }), (c) => c.json({ ok: true }));
    const call = () => probe.request('/probe', { headers: { 'X-Platform-Key': pk } }, env);

    expect((await call()).status).toBe(200);
    expect((await api(w.tok.owner, 'PATCH', `/products/${w.a}`, { status: 'disabled' })).status).toBe(200);
    expect(await errorCode(await call())).toBe('product_disabled');
    expect((await api(w.tok.owner, 'PATCH', `/products/${w.a}`, { status: 'archived' })).status).toBe(200);
    expect(await errorCode(await call())).toBe('product_disabled');
    await api(w.tok.owner, 'PATCH', `/products/${w.a}`, { status: 'active' });
    expect((await call()).status).toBe(200);
  });
});
