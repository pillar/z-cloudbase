// /v1/me: profile, leave product, this product's requests, CORS. Account deletion / export live on the identity domain.
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, errCode, identityStub } from './api-helpers.ts';
import { minter, seedMembership, seedProduct, seedServiceKey, userFor, type SeededEnv } from './helpers.ts';

const revokeUserTokens = identityStub.revokeUserTokens;
let a: SeededEnv;
let b: SeededEnv;
beforeAll(async () => {
  a = await seedProduct({ productId: 'me_a', allowedOrigins: ['https://a.example'] });
  b = await seedProduct({ productId: 'me_b' });
});
beforeEach(() => {
  revokeUserTokens.mockReset();
  revokeUserTokens.mockResolvedValue(undefined);
});

const asA = (u: { token: string }) => ({ key: a.publishableKey, token: u.token });
const asB = (u: { token: string }) => ({ key: b.publishableKey, token: u.token });
const DAY = 24 * 3600_000;

describe('GET /v1/me', () => {
  it('describes the user within this product only', async () => {
    const u = await userFor(a, { anon: true });
    await seedMembership(u.userId, b.productId); // a second product must stay invisible
    const res = await call('/v1/me', asA(u));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toEqual({
      user_id: u.userId, anonymous: true, product_id: 'me_a', env: 'prod',
      membership: { status: 'active', joined_at: expect.any(String) },
    });
    expect(JSON.stringify(body)).not.toContain('me_b');
  });

  it('requires a publishable key and a token', async () => {
    const u = await userFor(a);
    expect(await errCode(await call('/v1/me', { key: a.publishableKey }))).toBe('unauthenticated');
    expect(await errCode(await call('/v1/me'))).toBe('unauthenticated');
    const sk = await seedServiceKey(a.productEnvId, ['storage:read']);
    expect(await errCode(await call('/v1/me', { key: sk, token: u.token }))).toBe('forbidden');
  });

  it('exposes no endpoint that lists the products of a user', async () => {
    const u = await userFor(a);
    expect((await call('/v1/me/products', asA(u))).status).toBe(404);
  });

  it("rejects A's token with B's key", async () => {
    const u = await userFor(a);
    await seedMembership(u.userId, b.productId);
    const res = await call('/v1/me', asB(u));
    expect(res.status).toBe(401);
    expect(await errCode(await call('/v1/me/requests', asB(u)))).toBe('invalid_token');
  });
});

describe('DELETE /v1/me/membership', () => {
  it('revokes tokens and membership for this product only, queues storage cleanup and audits', async () => {
    const u = await userFor(a);
    await seedMembership(u.userId, b.productId);
    const bToken = await (await minter()).mint({ productId: 'me_b', env: 'prod', userId: u.userId });

    const res = await call('/v1/me/membership', { ...asA(u), method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(revokeUserTokens).toHaveBeenCalledWith({ userId: u.userId, productId: 'me_a', reason: expect.any(String) });

    const st = (pid: string) => env.DB.prepare('SELECT status FROM product_memberships WHERE user_id = ? AND product_id = ?').bind(u.userId, pid).first();
    expect(await st('me_a')).toEqual({ status: 'revoked' });
    expect(await st('me_b')).toEqual({ status: 'active' });

    const del = await env.DB.prepare(`SELECT kind, scope, product_id, status, due_at <= ? AS due FROM deletion_requests WHERE user_id = ?`).bind(Date.now(), u.userId).all();
    expect(del.results).toEqual([{ kind: 'delete', scope: 'product', product_id: 'me_a', status: 'pending', due: 1 }]);
    const audit = await env.DB.prepare(`SELECT actor_id, product_id FROM audit_log WHERE action = 'me.membership.leave' AND actor_id = ?`).bind(u.userId).first();
    expect(audit).toEqual({ actor_id: u.userId, product_id: 'me_a' });

    // access to A ends immediately; B is unaffected
    expect(await errCode(await call('/v1/me', asA(u)))).toBe('membership_required');
    expect((await call('/v1/me', { key: b.publishableKey, token: bToken })).status).toBe(200);
  });

  it('leaves everything unchanged and reports unavailable when token revocation fails', async () => {
    revokeUserTokens.mockRejectedValue(new Error('identity down'));
    const u = await userFor(a);
    const res = await call('/v1/me/membership', { ...asA(u), method: 'DELETE' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.retryable).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM product_memberships WHERE user_id = ? AND product_id = ?').bind(u.userId, 'me_a').first()).toEqual({ status: 'active' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM deletion_requests WHERE user_id = ?').bind(u.userId).first<{ n: number }>())!.n).toBe(0);
    expect((await call('/v1/me', asA(u))).status).toBe(200);
  });
});

describe('account-level requests are not offered by product APIs', () => {
  it('has no deletion or export initiation (identity domain only)', async () => {
    const u = await userFor(a);
    for (const [path, method] of [['/v1/me/deletion', 'POST'], ['/v1/me/deletion', 'DELETE'], ['/v1/me/export', 'POST']] as const) {
      expect((await call(path, { ...asA(u), method })).status).toBe(404);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM deletion_requests WHERE user_id = ?').bind(u.userId).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('GET /v1/me/requests', () => {
  it("lists only this product's leave requests, never account-level or other products' requests or internal refs", async () => {
    const u = await userFor(a);
    const other = await userFor(a);
    await seedMembership(u.userId, b.productId);
    const now = Date.now();
    const insert = (id: string, userId: string, kind: string, scope: string, productId: string | null, ref: string | null) =>
      env.DB.prepare(`INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at, result_ref) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`)
        .bind(id, userId, kind, scope, productId, now, now, ref).run();
    await insert('del_leave_a', u.userId, 'delete', 'product', 'me_a', null);
    await insert('del_leave_b', u.userId, 'delete', 'product', 'me_b', null);
    await insert('del_account_export', u.userId, 'export', 'account', null, 'secret/ref');
    await insert('del_other_user', other.userId, 'delete', 'product', 'me_a', null);

    const body = (await (await call('/v1/me/requests', asA(u))).json()) as { requests: Record<string, unknown>[] };
    expect(body.requests.map((r) => r.id)).toEqual(['del_leave_a']);
    expect(body.requests[0]).toMatchObject({ kind: 'delete', scope: 'product', status: 'completed' });
    expect(JSON.stringify(body)).not.toMatch(/secret\/ref|me_b|del_other|del_account/);
    expect(Object.keys(body.requests[0]!)).not.toContain('user_id');

    // the B row is visible from the product it belongs to
    const bToken = await (await minter()).mint({ productId: 'me_b', env: 'prod', userId: u.userId });
    const fromB = (await (await call('/v1/me/requests', { key: b.publishableKey, token: bToken })).json()) as { requests: { id: string }[] };
    expect(fromB.requests.map((r) => r.id)).toEqual(['del_leave_b']);
  });

  it('needs a user token', async () => {
    expect(await errCode(await call('/v1/me/requests', { key: a.publishableKey }))).toBe('unauthenticated');
    expect(await errCode(await call('/v1/me/membership', { key: a.publishableKey, method: 'DELETE' }))).toBe('unauthenticated');
  });
});

describe('CORS on /v1/*', () => {
  it('answers preflight without the key header and allows the needed headers', async () => {
    const res = await call('/v1/storage/uploads', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://a.example', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,x-platform-key,idempotency-key',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://a.example');
    const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase();
    for (const h of ['content-type', 'authorization', 'x-platform-key', 'idempotency-key']) expect(allowed).toContain(h);
  });

  it('allows every method the API routes use, including PATCH (console product / environment updates)', async () => {
    const res = await call('/v1/admin/products/a', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
    expect(res.status).toBe(204);
    const methods = res.headers.get('access-control-allow-methods')!.toUpperCase().split(/\s*,\s*/);
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(methods).toContain(m);
  });

  it('exposes x-request-id and still origin-checks real requests', async () => {
    const u = await userFor(a);
    const ok = await call('/v1/me', { ...asA(u), headers: { Origin: 'https://a.example' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-expose-headers')!.toLowerCase()).toContain('x-request-id');
    expect(ok.headers.get('x-request-id')).toMatch(/^req_/);

    const evil = await call('/v1/me', { ...asA(u), headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(await errCode(evil)).toBe('forbidden');
  });
});
