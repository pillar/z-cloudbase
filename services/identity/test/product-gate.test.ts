// Product admission in the authorization flow (PRD §4.2, §6.2 step 3, §19.4): product status,
// open / restricted visibility and membership status gate authorize, code exchange and refresh.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, call, membership, seedProduct, setMembership, signUp } from './helpers.ts';
import {
  REDIRECT,
  authorizeWithLogin,
  authorizeWithSession,
  exchangeCode,
  pkcePair,
  randomToken,
  refresh,
  setupClients,
  ssoToProduct,
  tokenRequest,
} from './oauth-flow.ts';

const OPEN = 'gate_open';
const RESTRICTED = 'gate_restricted';
const OTHER = 'gate_other';

async function authorize(jar: CookieJar, productId: string) {
  const { challenge, verifier } = await pkcePair();
  const state = randomToken();
  const cb = await authorizeWithSession(jar, { productId, env: 'prod', state, nonce: randomToken(), challenge });
  return { cb, state, verifier };
}

function expectDenied(cb: URL, productId: string, state: string, reason: RegExp) {
  expect(`${cb.origin}${cb.pathname}`).toBe(REDIRECT(productId));
  expect(cb.searchParams.get('code')).toBeNull();
  expect(cb.searchParams.get('error')).toBe('access_denied');
  expect(cb.searchParams.get('error_description')).toMatch(reason);
  expect(cb.searchParams.get('state')).toBe(state);
  expect(cb.searchParams.get('iss')).toBe(env.ISSUER);
}

describe('product admission', () => {
  beforeAll(async () => {
    await setupClients([
      { productId: OPEN, env: 'prod' },
      { productId: RESTRICTED, env: 'prod' },
      { productId: OTHER, env: 'prod' },
    ]);
    await seedProduct(RESTRICTED, { visibility: 'restricted' });
  });

  it('open product: the first successful authorization creates an active membership', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    expect(await membership(userId, OPEN)).toBeNull();
    await ssoToProduct(jar, OPEN);
    const m = await membership(userId, OPEN);
    expect(m).toMatchObject({ status: 'active' });
    expect(m!.last_seen_at).toBeGreaterThanOrEqual(m!.joined_at);
  });

  it('restricted product without membership: access_denied to the client, no code, no membership', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const { cb, state } = await authorize(jar, RESTRICTED);
    expectDenied(cb, RESTRICTED, state, /membership required/);
    expect(await membership(userId, RESTRICTED)).toBeNull();
  });

  it('restricted product is denied right after sign-in too (resumed authorization)', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const { challenge } = await pkcePair();
    const state = randomToken();
    const cb = await authorizeWithLogin(new CookieJar(), email, { productId: RESTRICTED, env: 'prod', state, nonce: randomToken(), challenge });
    expectDenied(cb, RESTRICTED, state, /membership required/);
    expect(await membership(userId, RESTRICTED)).toBeNull();
  });

  it('restricted product with an active membership: authorized and last_seen_at recorded', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await setMembership(userId, RESTRICTED, 'active');
    await ssoToProduct(jar, RESTRICTED);
    expect((await membership(userId, RESTRICTED))!.last_seen_at).not.toBeNull();
  });

  it('suspended or revoked memberships are denied even on an open product and never reactivated', async () => {
    for (const status of ['suspended', 'revoked'] as const) {
      const jar = new CookieJar();
      const { userId } = await signUp(jar);
      await setMembership(userId, OPEN, status);
      const { cb, state } = await authorize(jar, OPEN);
      expectDenied(cb, OPEN, state, new RegExp(`membership is ${status}`));
      expect((await membership(userId, OPEN))!.status).toBe(status);
    }
  });

  it('a disabled product is denied even with an active membership', async () => {
    await setupClients([{ productId: 'gate_disabled', env: 'prod' }]);
    await seedProduct('gate_disabled', { status: 'disabled' });
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await setMembership(userId, 'gate_disabled', 'active');
    const { cb, state } = await authorize(jar, 'gate_disabled');
    expectDenied(cb, 'gate_disabled', state, /not available/);
  });

  it('refresh fails while the product is disabled or the membership is not active', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const t0 = await ssoToProduct(jar, OPEN);

    await seedProduct(OPEN, { status: 'disabled' });
    const disabled = await refresh(OPEN, 'prod', t0.refresh_token!);
    await seedProduct(OPEN, { status: 'active' });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toMatchObject({ error: 'invalid_grant' });

    // Gating did not consume the token: once the product is active again, refresh works.
    const t1 = await refresh(OPEN, 'prod', t0.refresh_token!);
    expect(t1.status).toBe(200);
    const rotated = (await t1.json<{ refresh_token: string }>()).refresh_token;

    await setMembership(userId, OPEN, 'suspended');
    const suspended = await refresh(OPEN, 'prod', rotated);
    expect(suspended.status).toBe(400);
    expect(await suspended.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refresh updates last_seen_at', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const t0 = await ssoToProduct(jar, OPEN);
    await env.DB.prepare('UPDATE product_memberships SET last_seen_at = 1 WHERE user_id = ? AND product_id = ?').bind(userId, OPEN).run();
    expect((await refresh(OPEN, 'prod', t0.refresh_token!)).status).toBe(200);
    expect((await membership(userId, OPEN))!.last_seen_at).toBeGreaterThan(1);
  });

  it('an authorization code issued before the membership was revoked cannot be exchanged', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const { cb, verifier } = await authorize(jar, OPEN);
    await setMembership(userId, OPEN, 'revoked');
    const res = await exchangeCode(OPEN, 'prod', cb.searchParams.get('code')!, verifier);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('cross-product isolation: membership of one product admits nothing else', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const a = await ssoToProduct(jar, OPEN);
    // Membership in OPEN does not satisfy RESTRICTED.
    const { cb, state } = await authorize(jar, RESTRICTED);
    expectDenied(cb, RESTRICTED, state, /membership required/);
    // OPEN's refresh token is useless at another product's client.
    const res = await tokenRequest({ grant_type: 'refresh_token', client_id: `${OTHER}.prod`, refresh_token: a.refresh_token! });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await membership(userId, OTHER)).toBeNull();
  });

  it('anonymous users can enter open products but not restricted ones', async () => {
    const jar = new CookieJar();
    const res = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
    const anonId = (await res.json<{ user: { id: string } }>()).user.id;
    await ssoToProduct(jar, OPEN);
    expect((await membership(anonId, OPEN))!.status).toBe('active');
    const { cb, state } = await authorize(jar, RESTRICTED);
    expectDenied(cb, RESTRICTED, state, /membership required/);
  });
});
