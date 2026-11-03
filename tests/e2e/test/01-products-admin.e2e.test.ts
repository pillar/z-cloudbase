// PRD §15 item 1: two products A and B created by the owner through the admin API, each with its
// environments; product admins assigned; B's admin cannot read A's private data. TOTP is optional
// for administrators by default (PRD §19.11), but one who enabled it must pass it at console sign-in.
import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';
import { totp } from '../../../packages/testing/src/totp.ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { Browser, type Login } from '../src/browser.ts';
import {
  CONSOLE_ORIGIN, admin, authorizeCode, consoleToken, createProduct, newUser, ownerToken as ownerConsoleToken, stack, uniqueProductId, type ProductEnv,
} from '../src/world.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;
let b: Awaited<ReturnType<typeof createProduct>>;
let adminA: string;
let adminB: string;
let loginA: Login;
let loginB: Login;
/** B's identity session from sign-up (per-account sign-ins are limited to 5 / minute). */
let browserB: Browser;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
});

describe('§15-1 products, environments and product admins', () => {
  it('the owner creates products A and B with dev / staging / prod environments and OIDC clients', async () => {
    a = await createProduct(ownerToken, uniqueProductId('pa'), { name: 'Product A' });
    b = await createProduct(ownerToken, uniqueProductId('pb'), { name: 'Product B' });
    for (const p of [a, b]) {
      expect(p.raw.environments.map((e) => e.env)).toEqual(['dev', 'staging', 'prod']);
      for (const e of p.raw.environments) expect(e.publishable_key).toMatch(new RegExp(`^pk_${e.env}_`));
    }
    const list = await admin<{ products: Array<{ id: string }> }>(ownerToken, 'GET', '/products');
    expect(list.body.products.map((p) => p.id)).toEqual(expect.arrayContaining([a.productId, b.productId]));
    // Duplicate creation is a 409 conflict.
    expect((await admin(ownerToken, 'POST', '/products', { product_id: a.productId, name: 'dup' })).status).toBe(409);
  });

  it('assigns a product admin to each product (accounts signed up normally, roles granted by the owner)', async () => {
    const ua = await newUser('admin-a');
    const ub = await newUser('admin-b');
    for (const [u, p] of [[ua, a], [ub, b]] as const) {
      const r = await admin(ownerToken, 'POST', '/team', { user_id: u.userId, role: 'product_admin', product_id: p.productId });
      expect(r.status).toBe(201);
    }
    expect((await admin(ownerToken, 'POST', '/team', { user_id: ua.userId, role: 'product_admin', product_id: a.productId })).body.error.code).toBe('conflict');
    [loginA, loginB, browserB] = [ua.login, ub.login, ub.browser];
    adminA = await consoleToken(loginA);
    adminB = await consoleToken(loginB);
    const me = await admin<{ grants: Array<{ role: string; productId: string }> }>(adminB, 'GET', '/me');
    expect(me.body.grants).toEqual([{ role: 'product_admin', productId: b.productId }]);
  });

  it('console sign-in: the password is enough by default; once an admin enables TOTP the code is required', async () => {
    // Both admins got their console tokens above with the password alone.
    for (const login of [loginA, loginB]) expect(login.totp?.secret).toBeUndefined();
    const consoleClient = { clientId: CONSOLE_CLIENT_ID, redirectUri: `${CONSOLE_ORIGIN}/`, resource: CONSOLE_AUDIENCE };

    // B enables TOTP from their identity session (account page: password, key, first code).
    const browser = browserB;
    const setup = await (await browser.request(`${stack().issuer}/two-factor/setup`, { form: { password: loginB.password, return: '' } })).text();
    const secret = /data-totp-secret>([A-Z2-7]+)</.exec(setup)?.[1];
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect([...setup.matchAll(/data-backup-code>/g)]).toHaveLength(10);
    const confirm = await browser.request(`${stack().issuer}/two-factor/setup/confirm`, { form: { code: await totp(secret!), return: '' } });
    expect(confirm.status).toBe(302);

    // Password alone is no longer enough for B: the identity domain stops at the code prompt.
    await expect(authorizeCode(new Browser(stack().issuer), { ...consoleClient, login: { email: loginB.email, password: loginB.password } }))
      .rejects.toThrow(/asked for a TOTP code/);
    // With the authenticator (code computed per RFC 6238): a console token.
    loginB.totp = { secret: secret! };
    expect((await authorizeCode(new Browser(stack().issuer), { ...consoleClient, login: loginB })).tokens?.access_token).toBeTruthy();
    // A, without TOTP, still signs in with the password.
    expect((await authorizeCode(new Browser(stack().issuer), { ...consoleClient, login: { email: loginA.email, password: loginA.password } })).tokens?.access_token).toBeTruthy();
  });

  it("B's admin sees only B and gets 403 on every A resource; A's admin can read A", async () => {
    const list = await admin<{ products: Array<{ id: string }> }>(adminB, 'GET', '/products');
    expect(list.body.products.map((p) => p.id)).toEqual([b.productId]);
    const aPaths = [
      `/products/${a.productId}`,
      `/products/${a.productId}/memberships`,
      `/products/${a.productId}/service-keys`,
      `/products/${a.productId}/environments/prod/buckets`,
      `/products/${a.productId}/analytics?env=prod`,
      `/products/${a.productId}/logs?env=prod`,
      `/products/${a.productId}/usage`,
      `/audit?product_id=${a.productId}`,
    ];
    for (const path of aPaths) {
      const r = await admin(adminB, 'GET', path);
      expect([path, r.status]).toEqual([path, 403]);
      expect(JSON.stringify(r.body)).not.toContain('Product A');
    }
    const writes = [
      ['PATCH', `/products/${a.productId}`, { name: 'hijack' }],
      ['POST', `/products/${a.productId}/service-keys`, { env: 'prod', scopes: ['storage:read'] }],
      ['POST', `/products/${a.productId}/environments/prod/buckets`, { name: 'x-bucket' }],
    ] as const;
    for (const [method, path, body] of writes) expect((await admin(adminB, method, path, body)).status).toBe(403);
    expect((await admin(adminA, 'GET', `/products/${a.productId}`)).status).toBe(200);
    expect((await admin(adminA, 'GET', `/products/${b.productId}`)).status).toBe(403);
    // Platform-wide views stay owner-only.
    expect((await admin(adminA, 'GET', '/audit')).status).toBe(403);
    expect((await admin(adminA, 'GET', '/team')).status).toBe(403);
  });

  it('product mutations by admins are audited and visible to that product only', async () => {
    const env: ProductEnv = a.prod;
    expect((await admin(adminA, 'POST', `/products/${a.productId}/environments/${env.env}/buckets`, { name: 'docs' })).status).toBe(201);
    const audit = await admin<{ entries: Array<{ action: string; product_id: string }> }>(adminA, 'GET', `/audit?product_id=${a.productId}`);
    expect(audit.body.entries.map((e) => e.action)).toContain('bucket.create');
    expect(audit.body.entries.every((e) => e.product_id === a.productId)).toBe(true);
  });
});
