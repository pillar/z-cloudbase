// Shared api auth context (src/middleware/auth.ts): credential, user and console resolution.
import { errorHandler, requestId } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/context.ts';
import { authorize, requireScope, withConsoleUser, withCredential, withUser } from '../src/middleware/auth.ts';
import { minter, seedMembership, seedProduct, seedServiceKey, seedTeamMember, userFor, type SeededEnv } from './helpers.ts';
import { env } from 'cloudflare:workers';

// Pattern for all api tests: the identity RPC client is replaced; JWKS comes from the test minter.
// The IDENTITY binding is injected through env: vi.mock('../src/identity.ts') cannot intercept modules that
// are already loaded as part of the worker entry graph (src/index.ts -> routes -> jwks.ts -> identity.ts).
const identityStub = { getJwks: async () => (globalThis as any).__testJwks };

const app = new Hono<AppEnv>();
app.use(requestId());
app.onError(errorHandler);
app.get('/pk-or-sk', withCredential({ allow: ['publishable', 'service'] }), withUser({ required: false }), (c) =>
  c.json({ product: c.get('cred').productId, user: c.get('user')?.userId ?? null }),
);
app.get('/user', withCredential({ allow: ['publishable'] }), withUser({ required: true }), (c) => c.json({ user: c.get('user')!.userId }));
app.get('/svc', withCredential({ allow: ['service'] }), requireScope('logs:write'), (c) => c.json({ ok: true }));
app.get('/admin/:pid', withConsoleUser(), (c) => {
  authorize(c, 'product:read', { productId: c.req.param('pid') });
  return c.json({ ok: true });
});

const call = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, { ...env, IDENTITY: identityStub } as unknown as Env);
const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

let a: SeededEnv;
let b: SeededEnv;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  a = await seedProduct({ productId: 'ctx_a', allowedOrigins: ['https://a.example'] });
  b = await seedProduct({ productId: 'ctx_b' });
});

describe('withCredential', () => {
  it('derives product context from the key, not the request', async () => {
    const res = await call('/pk-or-sk', { 'X-Platform-Key': a.publishableKey });
    expect(await res.json()).toEqual({ product: 'ctx_a', user: null });
  });

  it('rejects missing, unknown, revoked and wrong-kind keys', async () => {
    expect(await code(await call('/pk-or-sk'))).toBe('unauthenticated');
    expect(await code(await call('/pk-or-sk', { 'X-Platform-Key': 'pk_prod_' + 'x'.repeat(33) }))).toBe('unauthenticated');
    const revoked = await seedServiceKey(a.productEnvId, ['logs:write'], { revoked: true });
    expect(await code(await call('/svc', { 'X-Platform-Key': revoked }))).toBe('unauthenticated');
    expect(await code(await call('/svc', { 'X-Platform-Key': a.publishableKey }))).toBe('forbidden');
  });

  it('enforces service scopes', async () => {
    expect((await call('/svc', { 'X-Platform-Key': await seedServiceKey(a.productEnvId, ['logs:write']) })).status).toBe(200);
    expect(await code(await call('/svc', { 'X-Platform-Key': await seedServiceKey(a.productEnvId, ['events:write']) }))).toBe('forbidden');
  });

  it('rejects disabled products immediately and disallowed browser origins', async () => {
    const d = await seedProduct({ productId: 'ctx_disabled', status: 'disabled' });
    expect(await code(await call('/pk-or-sk', { 'X-Platform-Key': d.publishableKey }))).toBe('product_disabled');
    expect(await code(await call('/pk-or-sk', { 'X-Platform-Key': a.publishableKey, Origin: 'https://evil.example' }))).toBe('forbidden');
    expect((await call('/pk-or-sk', { 'X-Platform-Key': a.publishableKey, Origin: 'https://a.example' })).status).toBe(200);
  });
});

describe('withUser', () => {
  it("accepts a member's token for its product", async () => {
    const u = await userFor(a);
    const res = await call('/user', { 'X-Platform-Key': a.publishableKey, Authorization: `Bearer ${u.token}` });
    expect(await res.json()).toEqual({ user: u.userId });
  });

  it("rejects product A's token presented with product B's key (PRD §15)", async () => {
    const u = await userFor(a);
    await seedMembership(u.userId, b.productId);
    const res = await call('/user', { 'X-Platform-Key': b.publishableKey, Authorization: `Bearer ${u.token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_token');
    expect(JSON.stringify(body)).not.toContain(u.userId);
  });

  it('requires an active membership even with a valid token', async () => {
    const u = await userFor(a);
    await seedMembership(u.userId, a.productId, 'suspended');
    expect(await code(await call('/user', { 'X-Platform-Key': a.publishableKey, Authorization: `Bearer ${u.token}` }))).toBe('membership_required');
  });

  it('rejects an invalid token even where auth is optional', async () => {
    expect(await code(await call('/pk-or-sk', { 'X-Platform-Key': a.publishableKey, Authorization: 'Bearer abc.def.ghi' }))).toBe('invalid_token');
  });
});

describe('withConsoleUser + authorize', () => {
  it('confines product admins to their product and rejects non-members and product tokens', async () => {
    const m = await minter();
    await seedTeamMember('usr_ctx_admin', 'product_admin', 'ctx_a');
    const t = await m.mintConsole({ userId: 'usr_ctx_admin' });
    expect((await call('/admin/ctx_a', { Authorization: `Bearer ${t}` })).status).toBe(200);
    expect(await code(await call('/admin/ctx_b', { Authorization: `Bearer ${t}` }))).toBe('forbidden');
    expect(await code(await call('/admin/ctx_a', { Authorization: `Bearer ${await m.mintConsole({ userId: 'usr_nobody' })}` }))).toBe('forbidden');
    const productToken = await m.mint({ productId: 'ctx_a', env: 'prod', userId: 'usr_ctx_admin' });
    expect(await code(await call('/admin/ctx_a', { Authorization: `Bearer ${productToken}` }))).toBe('invalid_token');
  });
});

