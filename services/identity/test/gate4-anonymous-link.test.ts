// Gate 4 (PRD §19.1 / §19.7): anonymous user upgraded by linking Email/Password or Google
// keeps its user_id and flips anon=false; a credential owned by someone else is a conflict.
import { GOOGLE_ENDPOINTS, createMockOidcProvider, interceptFetch, type MockOidcProvider } from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CookieJar, PASSWORD, call, signUp, uniqueEmail } from './helpers.ts';
import { authorizeWithSession, exchangeCode, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';

let google: MockOidcProvider;

beforeAll(async () => {
  await setupClients([{ productId: 'product_a', env: 'prod' }]);
  google = await createMockOidcProvider(GOOGLE_ENDPOINTS);
  // Production config is untouched: the real `google` provider calls Google's fixed
  // endpoints, and only the test isolate's fetch is routed to the local mock.
  vi.spyOn(globalThis, 'fetch').mockImplementation(interceptFetch(globalThis.fetch.bind(globalThis), [google]));
});
afterAll(() => vi.restoreAllMocks());

async function anonymousSignIn() {
  const jar = new CookieJar();
  const res = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
  expect(res.status).toBe(200);
  const { user } = await res.json<{ user: { id: string; isAnonymous: boolean } }>();
  expect(user.isAnonymous).toBe(true);
  return { jar, userId: user.id };
}

/** OAuth into product_a with the jar's existing identity session (anonymous or not). */
async function productToken(jar: CookieJar) {
  const { verifier, challenge } = await pkcePair();
  const cb = await authorizeWithSession(jar, { productId: 'product_a', env: 'prod', state: randomToken(), nonce: randomToken(), challenge });
  const res = await exchangeCode('product_a', 'prod', cb.searchParams.get('code')!, verifier);
  expect(res.status).toBe(200);
  return decodeJwt((await res.json<TokenResponse>()).access_token);
}

async function userRow(id: string) {
  return env.DB.prepare('SELECT id, email, isAnonymous FROM "user" WHERE id = ?')
    .bind(id)
    .first<{ id: string; email: string; isAnonymous: number }>();
}

async function accounts(userId: string) {
  const r = await env.DB.prepare('SELECT providerId, accountId FROM account WHERE userId = ? ORDER BY providerId').bind(userId).all();
  return r.results as Array<{ providerId: string; accountId: string }>;
}

/** Google leg: start link/sign-in, approve at the mock IdP, deliver the callback. */
async function googleRoundTrip(jar: CookieJar, start: '/api/auth/link-social' | '/api/auth/sign-in/social', sub: string, email: string) {
  const res = await call(start, {
    jar,
    json: { provider: 'google', callbackURL: `${env.ISSUER}/done`, errorCallbackURL: `${env.ISSUER}/error`, disableRedirect: true },
  });
  expect(res.status).toBe(200);
  const { url } = await res.json<{ url: string }>();
  const back = google.authorize(url, { sub, email, email_verified: true });
  const cb = await call(back, { jar });
  expect(cb.status).toBe(302);
  return new URL(cb.headers.get('location')!, env.ISSUER);
}

describe('gate 4: anonymous upgrade keeps the user id', () => {
  it('anonymous user gets anon=true product tokens', async () => {
    const { jar, userId } = await anonymousSignIn();
    const claims = await productToken(jar);
    expect(claims).toMatchObject({ sub: userId, anon: true, pid: 'product_a' });
  });

  it('links Email/Password: same user_id, anon=false, can sign in with the new credential', async () => {
    const { jar, userId } = await anonymousSignIn();
    const email = uniqueEmail('upgrade');
    const res = await call('/link/email', { jar, json: { email, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: userId });
    expect(await userRow(userId)).toMatchObject({ id: userId, email, isAnonymous: 0 });

    const fresh = new CookieJar();
    const login = await call('/api/auth/sign-in/email', { jar: fresh, json: { email, password: PASSWORD } });
    expect(login.status).toBe(200);
    expect((await login.json<{ user: { id: string } }>()).user.id).toBe(userId);
    expect(await productToken(fresh)).toMatchObject({ sub: userId, anon: false });
  });

  it('linking an email owned by another user is a 409 conflict and merges nothing', async () => {
    const owner = await signUp(new CookieJar());
    const { jar, userId } = await anonymousSignIn();
    const before = await userRow(userId);
    const res = await call('/link/email', { jar, json: { email: owner.email, password: PASSWORD } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('identity_conflict');
    expect(await userRow(userId)).toEqual(before); // anonymous account unchanged
    expect(await accounts(userId)).toEqual([]);
    expect((await accounts(owner.userId)).map((a) => a.providerId)).toEqual(['credential']);
  });

  it('links Google (mock IdP): same user_id, anon=false', async () => {
    const { jar, userId } = await anonymousSignIn();
    const sub = `google-${randomToken(8)}`;
    const landed = await googleRoundTrip(jar, '/api/auth/link-social', sub, uniqueEmail('g'));
    expect(landed.pathname).toBe('/done');
    expect(await accounts(userId)).toEqual([{ providerId: 'google', accountId: sub }]);
    expect((await userRow(userId))!.isAnonymous).toBe(0);
    expect(await productToken(jar)).toMatchObject({ sub: userId, anon: false });
    // The token request carried PKCE to the IdP.
    expect(google.tokenRequests.at(-1)!.get('code_verifier')).toBeTruthy();
  });

  it('linking a Google identity owned by another user is a conflict and merges nothing', async () => {
    const sub = `google-${randomToken(8)}`;
    const ownerJar = new CookieJar();
    const signedIn = await googleRoundTrip(ownerJar, '/api/auth/sign-in/social', sub, uniqueEmail('owner'));
    expect(signedIn.pathname).toBe('/done');
    const owner = await env.DB.prepare(`SELECT userId FROM account WHERE providerId = 'google' AND accountId = ?`).bind(sub).first<{ userId: string }>();

    const { jar, userId } = await anonymousSignIn();
    const landed = await googleRoundTrip(jar, '/api/auth/link-social', sub, uniqueEmail('other'));
    expect(landed.pathname).toBe('/error');
    expect(landed.searchParams.get('error')).toBe('account_already_linked_to_different_user');
    expect(await accounts(userId)).toEqual([]);
    expect((await userRow(userId))!.isAnonymous).toBe(1);
    expect((await accounts(owner!.userId)).map((a) => a.providerId)).toEqual(['google']);
  });

  it('Google sign-in with an email that matches an existing user does not link implicitly', async () => {
    const existing = await signUp(new CookieJar());
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(existing.userId).run();
    const landed = await googleRoundTrip(new CookieJar(), '/api/auth/sign-in/social', `google-${randomToken(8)}`, existing.email);
    expect(landed.pathname).toBe('/error');
    expect(landed.searchParams.get('error')).toBe('account_not_linked');
    expect((await accounts(existing.userId)).map((a) => a.providerId)).toEqual(['credential']);
  });

  it('an anonymous user signing in to an existing account is kept unchanged (no merge, no delete)', async () => {
    const existing = await signUp(new CookieJar());
    const { jar, userId } = await anonymousSignIn();
    const res = await call('/api/auth/sign-in/email', { jar, json: { email: existing.email, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect((await res.json<{ user: { id: string } }>()).user.id).toBe(existing.userId);
    expect((await userRow(userId))!.isAnonymous).toBe(1);
    expect(await accounts(userId)).toEqual([]);
  });
});
