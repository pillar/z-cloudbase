// Google and Apple sign-in against the mock IdP (PRD §4.2 items 8, 9, 12). Production config is
// unchanged: the engine's providers call the real endpoints and only this isolate's fetch is
// routed to the mock. Local only — real provider behaviour is pending remote verification.
import {
  APPLE_ENDPOINTS,
  GOOGLE_ENDPOINTS,
  createMockOidcProvider,
  interceptFetch,
  type MockIdTokenOptions,
  type MockIdpUser,
  type MockOidcProvider,
} from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPLE_ORIGIN } from '../src/social.ts';
import { CookieJar, call, signUp } from './helpers.ts';
import { randomToken } from './oauth-flow.ts';

let google: MockOidcProvider;
let apple: MockOidcProvider;

beforeAll(async () => {
  google = await createMockOidcProvider(GOOGLE_ENDPOINTS);
  apple = await createMockOidcProvider(APPLE_ENDPOINTS);
  vi.spyOn(globalThis, 'fetch').mockImplementation(interceptFetch(globalThis.fetch.bind(globalThis), [google, apple]));
});
afterAll(() => vi.restoreAllMocks());

type Provider = 'google' | 'apple';
type Start = '/api/auth/sign-in/social' | '/api/auth/link-social';

/** Start sign-in or linking at the engine; returns the IdP authorization URL. */
async function start(jar: CookieJar, provider: Provider, path: Start = '/api/auth/sign-in/social') {
  const res = await call(path, {
    jar,
    json: { provider, callbackURL: `${env.ISSUER}/done`, errorCallbackURL: `${env.ISSUER}/error`, disableRedirect: true },
  });
  expect(res.status).toBe(200);
  return new URL((await res.json<{ url: string }>()).url);
}

/**
 * Apple answers with an auto-submitted cross-site form POST. A browser sends no SameSite=Lax
 * cookies with it, so the POST carries none here; the engine bounces it to a same-URL GET (a
 * top-level navigation, which does carry Lax cookies) and only then checks state.
 */
async function deliverFormPost(jar: CookieJar, action: string, form: URLSearchParams) {
  const post = await call(action, {
    form: Object.fromEntries(form),
    headers: { origin: APPLE_ORIGIN, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  });
  expect(post.status).toBe(302);
  const bounce = new URL(post.headers.get('location')!, env.ISSUER);
  expect(`${bounce.origin}${bounce.pathname}`).toBe(action);
  expect(bounce.searchParams.get('code')).toBe(form.get('code'));
  return call(bounce.toString(), { jar });
}

/** Full round trip; returns where the browser lands. */
async function roundTrip(jar: CookieJar, provider: Provider, user: MockIdpUser, opts: { path?: Start; nonce?: string; idToken?: MockIdTokenOptions } = {}) {
  const url = await start(jar, provider, opts.path);
  const idp = provider === 'google' ? google : apple;
  const cb =
    provider === 'apple'
      ? await (async () => {
          const { action, form } = apple.authorizeFormPost(url.toString(), user, opts);
          return deliverFormPost(jar, action, form);
        })()
      : await call(idp.authorize(url.toString(), user, opts), { jar });
  expect(cb.status).toBe(302);
  return new URL(cb.headers.get('location')!, env.ISSUER);
}

async function accountOwner(provider: Provider, sub: string) {
  return env.DB.prepare('SELECT userId FROM account WHERE providerId = ? AND accountId = ?').bind(provider, sub).first<{ userId: string }>();
}

async function userRow(id: string) {
  return env.DB.prepare('SELECT email, emailVerified, isAnonymous FROM "user" WHERE id = ?')
    .bind(id)
    .first<{ email: string; emailVerified: number; isAnonymous: number | null }>();
}

describe('social sign-in (mock IdP)', () => {
  it('Apple authorization requests use form_post, PKCE and a nonce', async () => {
    const url = await start(new CookieJar(), 'apple');
    expect(`${url.origin}${url.pathname}`).toBe(APPLE_ENDPOINTS.authorization);
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });

  it('the OAuth state cookie is SameSite=Lax, so the form_post callback depends on the GET bounce', async () => {
    const res = await call('/api/auth/sign-in/social', {
      json: { provider: 'apple', callbackURL: `${env.ISSUER}/done`, disableRedirect: true },
    });
    const state = res.headers.getSetCookie().find((c) => /better-auth\.state=/.test(c));
    expect(state).toMatch(/SameSite=Lax/i);
  });

  it('Apple sign-in with a private-relay email via form_post creates one user; signing in again reuses it', async () => {
    const sub = `apple-${randomToken(8)}`;
    const relay = `${randomToken(6).toLowerCase()}@privaterelay.appleid.com`;
    const user: MockIdpUser = { sub, email: relay, email_verified: 'true', name: 'Ann Apple', claims: { is_private_email: 'true' } };

    const jar = new CookieJar();
    const landed = await roundTrip(jar, 'apple', user);
    expect(landed.pathname).toBe('/done');
    const owner = await accountOwner('apple', sub);
    expect(owner).not.toBeNull();
    expect(await userRow(owner!.userId)).toMatchObject({ email: relay, emailVerified: 1 });
    const session = await (await call('/api/auth/get-session', { jar })).json<{ user: { id: string } }>();
    expect(session.user.id).toBe(owner!.userId);

    const again = await roundTrip(new CookieJar(), 'apple', user);
    expect(again.pathname).toBe('/done');
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM account WHERE providerId = 'apple' AND accountId = ?`).bind(sub).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('an Apple callback whose GET leg arrives without the state cookie is rejected', async () => {
    const jar = new CookieJar();
    const url = await start(jar, 'apple');
    const { action, form } = apple.authorizeFormPost(url.toString(), { sub: `apple-${randomToken(8)}`, email: 'x@privaterelay.appleid.com' });
    const res = await deliverFormPost(new CookieJar(), action, form); // the browser lost the cookies
    expect(res.status).toBe(302);
    const landed = new URL(res.headers.get('location')!, env.ISSUER);
    expect(landed.searchParams.get('error')).toMatch(/state/);
  });

  it('Google sign-in maps the same Google subject to the same user', async () => {
    const sub = `google-${randomToken(8)}`;
    const email = `g-${randomToken(6).toLowerCase()}@gmail.example`;
    expect((await roundTrip(new CookieJar(), 'google', { sub, email })).pathname).toBe('/done');
    const first = await accountOwner('google', sub);
    expect((await roundTrip(new CookieJar(), 'google', { sub, email })).pathname).toBe('/done');
    expect(await accountOwner('google', sub)).toEqual(first);
  });

  it('an Apple identity whose (relay) email equals an existing user is not linked implicitly', async () => {
    const existing = await signUp(new CookieJar());
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(existing.userId).run();
    const landed = await roundTrip(new CookieJar(), 'apple', { sub: `apple-${randomToken(8)}`, email: existing.email, email_verified: 'true' });
    expect(landed.pathname).toBe('/error');
    expect(landed.searchParams.get('error')).toBe('account_not_linked');
    const accounts = await env.DB.prepare('SELECT providerId FROM account WHERE userId = ?').bind(existing.userId).all();
    expect(accounts.results).toEqual([{ providerId: 'credential' }]);
  });
});

describe('provider id_token verification', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: Array<[string, { nonce?: string; idToken?: MockIdTokenOptions }]> = [
    ['a tampered payload (bad signature)', { idToken: { tamper: true } }],
    ['a token signed by a key the provider never published', { idToken: { foreignKey: true } }],
    ['a wrong nonce', { nonce: 'not-the-nonce-we-sent' }],
    ['no nonce', { nonce: '' }],
    ['another audience', { idToken: { claims: { aud: 'someone-elses-client' } } }],
    ['another issuer', { idToken: { claims: { iss: 'https://idp.evil.example' } } }],
    ['an expired token', { idToken: { claims: { iat: now() - 7200, exp: now() - 3600 } } }],
  ];

  for (const provider of ['google', 'apple'] as const) {
    for (const [label, opts] of cases) {
      it(`${provider}: rejects ${label} without creating or linking an account`, async () => {
        const sub = `${provider}-${randomToken(8)}`;
        const jar = new CookieJar();
        const landed = await roundTrip(jar, provider, { sub, email: `${sub}@example.test` }, opts);
        expect(landed.pathname).toBe('/error');
        expect(landed.searchParams.get('error')).toBe('unable_to_get_user_info');
        expect(await accountOwner(provider, sub)).toBeNull();
        expect(await (await call('/api/auth/get-session', { jar })).json()).toBeNull();
      });
    }
  }

  it('apple: an anonymous user links Apple in place (same id, anon cleared)', async () => {
    const jar = new CookieJar();
    const res = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
    const anonId = (await res.json<{ user: { id: string } }>()).user.id;
    const sub = `apple-${randomToken(8)}`;
    const landed = await roundTrip(jar, 'apple', { sub, email: `${sub}@privaterelay.appleid.com`, email_verified: 'true' }, { path: '/api/auth/link-social' });
    expect(landed.pathname).toBe('/done');
    expect(await accountOwner('apple', sub)).toEqual({ userId: anonId });
    expect((await userRow(anonId))!.isAnonymous).toBe(0);
  });

  it('apple: linking an Apple identity owned by someone else is a conflict, never a merge', async () => {
    const sub = `apple-${randomToken(8)}`;
    await roundTrip(new CookieJar(), 'apple', { sub, email: `${sub}@privaterelay.appleid.com` });
    const owner = await accountOwner('apple', sub);

    const jar = new CookieJar();
    const res = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
    const anonId = (await res.json<{ user: { id: string } }>()).user.id;
    const landed = await roundTrip(jar, 'apple', { sub, email: `${sub}@privaterelay.appleid.com` }, { path: '/api/auth/link-social' });
    expect(landed.pathname).toBe('/error');
    expect(landed.searchParams.get('error')).toBe('account_already_linked_to_different_user');
    expect(await accountOwner('apple', sub)).toEqual(owner);
    expect((await userRow(anonId))!.isAnonymous).toBe(1);
  });
});
