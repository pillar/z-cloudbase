// Magic link sign-in (PRD §21.3): mail via the outbox, single-use hashed tokens, callbacks restricted to
// this issuer's pages, continuation of an authorization request, registration modes, TOTP accounts.
import { AUTH_RATE_PER_IP_PER_MIN } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { awayFromWindowEdge, call, CookieJar, outbox, signUp, uniqueEmail, useEnv } from './helpers.ts';
import { enrollTotp } from './mfa.ts';
import { authorizeUrl, exchangeCode, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';

const location = (res: Response) => new URL(res.headers.get('location')!, env.ISSUER);
const session = async (jar: CookieJar) => (await call('/api/auth/get-session', { jar })).json<{ user: { id: string; email: string } } | null>();

beforeAll(async () => {
  await setupClients([{ productId: 'magic_app', env: 'prod' }]);
});
afterEach(() => useEnv(null));

/** Submit the sign-in page's magic-link form; returns the page and the mailed link (if any). */
async function requestLink(email: string, oauthQuery = '', ip?: string) {
  const res = await call('/login/magic-link', { form: { email, oauth_query: oauthQuery }, ...(ip ? { headers: { 'cf-connecting-ip': ip } } : {}) });
  const mail = (await outbox(email)).find((m) => m.template === 'magic_link');
  return { res, link: mail ? new URL(mail.payload.url!) : null };
}

describe('magic link', () => {
  it('signs an existing user in through the mailed link, which works once', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const { res, link } = await requestLink(email);
    expect(res.status).toBe(200);
    expect(link).not.toBeNull();
    expect(link!.pathname).toBe('/api/auth/magic-link/verify');
    // Only a hash of the token is stored.
    const token = link!.searchParams.get('token')!;
    const stored = await env.DB.prepare('SELECT identifier FROM verification WHERE identifier LIKE ?').bind('magic-link:%').all<{ identifier: string }>();
    expect(stored.results.some((r) => r.identifier.includes(token))).toBe(false);

    const jar = new CookieJar();
    const first = await call(`${link!.pathname}${link!.search}`, { jar });
    expect(first.status).toBe(302);
    expect(location(first).pathname).toBe('/account');
    expect((await session(jar))?.user.id).toBe(userId);

    const again = await call(`${link!.pathname}${link!.search}`, { jar: new CookieJar() });
    expect(location(again).pathname).toBe('/login');
    expect(location(again).searchParams.get('magic')).toBe('1');
    expect(location(again).searchParams.get('error')).toBeTruthy();
    expect(await (await call(`${location(again).pathname}${location(again).search}`)).text()).toContain('This sign-in link is invalid or expired');
  });

  it('answers the same page for known and unknown addresses; in open mode a new user gets a verified account', async () => {
    const known = await signUp(new CookieJar());
    const fresh = uniqueEmail('magic-new');
    const a = await requestLink(known.email);
    const b = await requestLink(fresh);
    const strip = (s: string) => s.replace(/req_[\w-]+/g, '');
    expect(strip(await a.res.text())).toBe(strip(await b.res.text()));
    const jar = new CookieJar();
    await call(`${b.link!.pathname}${b.link!.search}`, { jar });
    const s = await session(jar);
    expect(s?.user.email).toBe(fresh);
    const row = await env.DB.prepare('SELECT emailVerified FROM "user" WHERE email = ?').bind(fresh).first<{ emailVerified: number }>();
    expect(row?.emailVerified).toBe(1);
  });

  it('outside open mode it mails nobody without an account and creates no user', async () => {
    const known = await signUp(new CookieJar());
    useEnv({ SIGNUP_MODE: 'invite' });
    const stranger = uniqueEmail('magic-stranger');
    const { res, link } = await requestLink(stranger);
    expect(res.status).toBe(200);
    expect(link).toBeNull();
    expect((await requestLink(known.email)).link).not.toBeNull();
  });

  it('continues an authorization request: the link lands on the authorize endpoint and the product gets a code', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const { verifier, challenge } = await pkcePair();
    const state = randomToken();
    const browser = new CookieJar();
    const start = await call(authorizeUrl({ productId: 'magic_app', env: 'prod', state, nonce: randomToken(), challenge }), { jar: browser });
    const login = location(start);
    expect(login.pathname).toBe('/login');
    const { link } = await requestLink(email, login.search.slice(1));
    const landed = await call(`${link!.pathname}${link!.search}`, { jar: browser });
    const resume = location(landed);
    expect(resume.pathname).toBe('/api/auth/oauth2/authorize');
    expect(resume.searchParams.has('sig')).toBe(false);
    const cb = await call(`${resume.pathname}${resume.search}`, { jar: browser });
    const callback = location(cb);
    expect(callback.searchParams.get('state')).toBe(state);
    const tokens = await (await exchangeCode('magic_app', 'prod', callback.searchParams.get('code')!, verifier)).json<TokenResponse>();
    expect(decodeJwt(tokens.access_token)).toMatchObject({ sub: userId, pid: 'magic_app' });
  });

  it('refuses callbacks that are not pages of this issuer (JSON callers of the engine)', async () => {
    // A fresh address per attempt: the per-account limit (5 / minute) is not what this test is about.
    for (const callbackURL of ['https://evil.example/steal', '//evil.example/x', '/guest?authorize=x', '/api/auth/sign-out']) {
      const res = await call('/api/auth/sign-in/magic-link', { json: { email: uniqueEmail('cb'), callbackURL } });
      expect([400, 403], callbackURL).toContain(res.status);
    }
    expect((await call('/api/auth/sign-in/magic-link', { json: { email: uniqueEmail('cb'), callbackURL: '/account' } })).status).toBe(200);
  });

  it('an account with TOTP gets a notice instead of a link (mail alone does not bypass the second factor)', async () => {
    const jar = new CookieJar();
    const { email } = await signUp(jar);
    await enrollTotp(jar);
    const { link } = await requestLink(email);
    expect(link).toBeNull();
    expect((await outbox(email)).map((m) => m.template)).toContain('magic_link_unavailable');
  });

  it('is limited per IP like the other sign-in paths', { timeout: 30_000 }, async () => {
    const ip = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    await awayFromWindowEdge();
    for (let i = 0; i <= AUTH_RATE_PER_IP_PER_MIN; i++) statuses.push((await requestLink(uniqueEmail(`rl${i}`), '', ip)).res.status);
    expect(statuses.slice(0, AUTH_RATE_PER_IP_PER_MIN).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('is hidden and unavailable without a mail transport', async () => {
    useEnv({ DEPLOY_ENV: 'production' });
    expect(await (await call('/login')).text()).not.toContain('/login/magic-link');
    expect((await call('/login/magic-link', { form: { email: uniqueEmail(), oauth_query: '' } })).status).toBe(404);
    expect((await call('/api/auth/sign-in/magic-link', { json: { email: uniqueEmail() } })).status).toBe(404);
  });
});
