// Admin API, PRD §21.6: webhook endpoints per product environment — SSRF-guarded URLs, the secret shown once
// (create, rotate with a dual-signature grace period), enable / disable, test send with a signed request,
// the delivery log, per-environment quota, RBAC (developers: non-prod only) and cross-product isolation.
import { WEBHOOK_MAX_ENDPOINTS_PER_ENV } from '@z-cloudbase/contracts';
import { verifyWebhookSignature } from '@z-cloudbase/security';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, auditRows, dbValue, errorCode, initApp, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

const rpc = vi.hoisted(() => ({ upsertProductClient: vi.fn(), revokeUserTokens: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));

let w: World;
const sent: Array<{ url: string; headers: Headers; body: string }> = [];
let reply: () => Response = () => new Response('thanks');

beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  // Same module registry as the app loaded by initApp().
  const { setWebhookFetch } = await import('../src/lib/webhooks.ts');
  setWebhookFetch(async (url, init) => {
    sent.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return reply();
  });
  w = await makeWorld('wh');
});
beforeEach(() => {
  sent.length = 0;
  reply = () => new Response('thanks');
});

const base = (p: string, e = 'prod') => `/products/${p}/environments/${e}/webhooks`;

async function create(tok: string, p: string, e = 'prod', body: Json = {}) {
  return api(tok, 'POST', base(p, e), { url: 'https://hooks.example.com/z', event_types: ['user.joined', 'user.deleted'], ...body });
}

describe('webhook endpoints', () => {
  it('create returns the secret once; list never does; changes are audited without the secret', async () => {
    const res = await create(w.tok.adminA, w.a, 'prod', { description: 'CRM sync' });
    expect(res.status).toBe(201);
    const ep = (await res.json()) as Json;
    expect(ep).toMatchObject({ product_id: w.a, env: 'prod', url: 'https://hooks.example.com/z', enabled: true, event_types: ['user.joined', 'user.deleted'] });
    expect(ep.secret).toMatch(/^whsec_/);
    const list = (await (await api(w.tok.adminA, 'GET', base(w.a))).json()) as Json;
    expect(list.webhooks.map((x: Json) => x.id)).toContain(ep.id);
    expect(JSON.stringify(list)).not.toContain('whsec_');
    const audits = (await auditRows('webhook.create', w.a)).map((r) => r.metadata).join();
    expect(audits).not.toContain('whsec_');
  });

  it('applies the URL rules: https, no private or loopback addresses; http://localhost only in dev', async () => {
    for (const url of ['http://hooks.example.com/z', 'https://127.0.0.1/z', 'https://169.254.169.254/latest', 'https://[::1]/z', 'https://localhost/z', 'https://u:p@hooks.example.com/']) {
      const res = await create(w.tok.adminA, w.a, 'prod', { url });
      expect([url, res.status, await errorCode(res)]).toEqual([url, 400, 'validation_failed']);
    }
    expect((await create(w.tok.adminA, w.a, 'staging', { url: 'http://localhost:9000/hook' })).status).toBe(400);
    expect((await create(w.tok.adminA, w.a, 'dev', { url: 'http://localhost:9000/hook' })).status).toBe(201);
    expect((await create(w.tok.adminA, w.a, 'prod', { event_types: [] })).status).toBe(400);
    expect((await create(w.tok.adminA, w.a, 'prod', { event_types: ['webhook.test'] })).status).toBe(400);
  });

  it('test send: one signed POST with the Standard Webhooks headers, recorded in the delivery log', async () => {
    const ep = (await (await create(w.tok.adminA, w.a, 'staging')).json()) as Json;
    const res = await api(w.tok.adminA, 'POST', `${base(w.a, 'staging')}/${ep.id}/test`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Json;
    expect(out.attempt).toMatchObject({ status_code: 200, error: null, response_snippet: 'thanks', delivery_status: 'delivered', attempt: 1 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.url).toBe('https://hooks.example.com/z');
    expect(req.headers.get('webhook-id')).toBe(out.message_id);
    await expect(verifyWebhookSignature({ secret: ep.secret, headers: req.headers, body: req.body })).resolves.toMatchObject({ id: out.message_id });
    expect(JSON.parse(req.body)).toMatchObject({ id: out.message_id, type: 'webhook.test', product_id: w.a, env: 'staging', data: { webhook_id: ep.id } });

    reply = () => new Response('x'.repeat(5000), { status: 500 });
    const failed = (await (await api(w.tok.adminA, 'POST', `${base(w.a, 'staging')}/${ep.id}/test`)).json()) as Json;
    expect(failed.attempt).toMatchObject({ status_code: 500, error: 'http_500', delivery_status: 'failed' });
    expect(failed.attempt.response_snippet).toHaveLength(256);

    const log = (await (await api(w.tok.devA, 'GET', `${base(w.a, 'staging')}/${ep.id}/deliveries`)).json()) as Json;
    expect(log.attempts.map((a: Json) => a.status_code)).toEqual([500, 200]);
    expect(log.pending).toBe(0);
  });

  it('rotation: new secret once, the previous one keeps signing during the grace period', async () => {
    const ep = (await (await create(w.tok.adminA, w.a)).json()) as Json;
    const rot = (await (await api(w.tok.adminA, 'POST', `${base(w.a)}/${ep.id}/rotate-secret`)).json()) as Json;
    expect(rot.secret).toMatch(/^whsec_/);
    expect(rot.secret).not.toBe(ep.secret);
    await api(w.tok.adminA, 'POST', `${base(w.a)}/${ep.id}/test`);
    const req = sent.at(-1)!;
    expect(req.headers.get('webhook-signature')!.split(' ')).toHaveLength(2);
    for (const secret of [ep.secret, rot.secret]) await verifyWebhookSignature({ secret, headers: req.headers, body: req.body });
    expect((await auditRows('webhook.rotate_secret', w.a)).map((r) => r.metadata).join()).not.toContain('whsec_');
  });

  it('disable cancels queued deliveries and blocks test sends; delete removes the endpoint and its log', async () => {
    const ep = (await (await create(w.tok.adminA, w.a)).json()) as Json;
    const msg = 'msg_queued_1';
    const now = Date.now();
    const { env } = await import('cloudflare:workers');
    await env.DB.prepare(`INSERT INTO webhook_messages (id, product_env_id, event_type, payload, created_at) VALUES (?, ?, 'user.joined', '{}', ?)`).bind(msg, w.envs.a.prod, now).run();
    await env.DB.prepare(`INSERT INTO webhook_deliveries (message_id, endpoint_id, status, attempts, max_attempts, next_attempt_at, created_at) VALUES (?, ?, 'pending', 1, 8, ?, ?)`).bind(msg, ep.id, now + 60_000, now).run();
    const off = await api(w.tok.adminA, 'PATCH', `${base(w.a)}/${ep.id}`, { enabled: false });
    expect(((await off.json()) as Json).enabled).toBe(false);
    expect(await dbValue('SELECT status FROM webhook_deliveries WHERE message_id = ?', msg)).toEqual({ status: 'cancelled' });
    expect(await errorCode(await api(w.tok.adminA, 'POST', `${base(w.a)}/${ep.id}/test`))).toBe('conflict');
    expect((await api(w.tok.adminA, 'DELETE', `${base(w.a)}/${ep.id}`)).status).toBe(204);
    expect(await dbValue('SELECT 1 AS x FROM webhook_endpoints WHERE id = ?', ep.id)).toBeNull();
    expect(await dbValue('SELECT 1 AS x FROM webhook_deliveries WHERE endpoint_id = ?', ep.id)).toBeNull();
  });

  it(`allows at most ${WEBHOOK_MAX_ENDPOINTS_PER_ENV} endpoints per environment`, async () => {
    const pid = w.b;
    for (let i = 0; i < WEBHOOK_MAX_ENDPOINTS_PER_ENV; i++) expect((await create(w.tok.adminB, pid, 'staging')).status).toBe(201);
    expect(await errorCode(await create(w.tok.adminB, pid, 'staging'))).toBe('quota_exceeded');
  });
});

describe('webhook RBAC and isolation', () => {
  it('developers manage non-prod only; operators read only; product admins only their own product', async () => {
    expect((await create(w.tok.devA, w.a, 'dev', { url: 'https://hooks.example.com/dev' })).status).toBe(201);
    expect(await errorCode(await create(w.tok.devA, w.a, 'prod'))).toBe('forbidden');
    expect((await api(w.tok.devA, 'GET', base(w.a))).status).toBe(200);
    expect(await errorCode(await create(w.tok.operator, w.a, 'dev'))).toBe('forbidden');
    expect((await api(w.tok.operator, 'GET', base(w.a))).status).toBe(200);
    expect(await errorCode(await create(w.tok.adminB, w.a, 'dev'))).toBe('forbidden');
  });

  it("product A cannot read, change, test or delete product B's endpoints or their deliveries, also not via its own path", async () => {
    const epB = (await (await create(w.tok.adminB, w.b, 'prod')).json()) as Json;
    for (const [m, p, body] of [
      ['GET', base(w.b)], ['PATCH', `${base(w.b)}/${epB.id}`, { enabled: false }], ['DELETE', `${base(w.b)}/${epB.id}`],
      ['POST', `${base(w.b)}/${epB.id}/rotate-secret`], ['POST', `${base(w.b)}/${epB.id}/test`], ['GET', `${base(w.b)}/${epB.id}/deliveries`],
    ] as Array<[string, string, Json?]>) {
      expect([m, p, await errorCode(await api(w.tok.adminA, m, p, body))]).toEqual([m, p, 'forbidden']);
    }
    // B's endpoint id under A's own product path is simply not there.
    for (const [m, p, body] of [
      ['PATCH', `${base(w.a)}/${epB.id}`, { enabled: false }], ['DELETE', `${base(w.a)}/${epB.id}`],
      ['POST', `${base(w.a)}/${epB.id}/rotate-secret`], ['POST', `${base(w.a)}/${epB.id}/test`], ['GET', `${base(w.a)}/${epB.id}/deliveries`],
    ] as Array<[string, string, Json?]>) {
      expect([m, p, await errorCode(await api(w.tok.adminA, m, p, body))]).toEqual([m, p, 'not_found']);
    }
    // Or under another environment of B itself.
    expect(await errorCode(await api(w.tok.adminB, 'GET', `${base(w.b, 'dev')}/${epB.id}/deliveries`))).toBe('not_found');
    expect(await dbValue('SELECT enabled FROM webhook_endpoints WHERE id = ?', epB.id)).toEqual({ enabled: 1 });
    expect(sent).toHaveLength(0);
  });
});
