// Account security policy (PRD §4.2 items 11-12, §19.4, §19.7): 5-minute re-authentication
// for sensitive account changes, failure-safe anonymous Email/Password upgrade, link / unlink
// audit events, and "never unlink the last credential".
import { REAUTH_WINDOW_S } from '@z-cloudbase/contracts';
import { GOOGLE_ENDPOINTS, createMockOidcProvider, interceptFetch, type MockOidcProvider } from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CookieJar, PASSWORD, auditRows, auth, call, outbox, signIn, signUp, uniqueEmail } from './helpers.ts';
import { randomToken } from './oauth-flow.ts';

let google: MockOidcProvider;

beforeAll(async () => {
  google = await createMockOidcProvider(GOOGLE_ENDPOINTS);
  vi.spyOn(globalThis, 'fetch').mockImplementation(interceptFetch(globalThis.fetch.bind(globalThis), [google]));
});
afterAll(() => vi.restoreAllMocks());

/** Pretend the user's identity sessions were created `seconds` ago (same storage format as the engine). */
async function ageSessions(userId: string, seconds: number) {
  const row = await env.DB.prepare('SELECT createdAt FROM session WHERE userId = ? LIMIT 1').bind(userId).first<{ createdAt: string | number }>();
  const old = new Date(Date.now() - seconds * 1000);
  const value = typeof row!.createdAt === 'number' ? old.getTime() : old.toISOString();
  await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?').bind(value, userId).run();
}

async function anonymous() {
  const jar = new CookieJar();
  const res = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
  return { jar, userId: (await res.json<{ user: { id: string } }>()).user.id };
}

async function linkGoogle(jar: CookieJar, sub = `google-${randomToken(8)}`) {
  const res = await call('/api/auth/link-social', {
    jar,
    json: { provider: 'google', callbackURL: `${env.ISSUER}/done`, errorCallbackURL: `${env.ISSUER}/error`, disableRedirect: true },
  });
  if (res.status !== 200) return res;
  const { url } = await res.json<{ url: string }>();
  return call(google.authorize(url, { sub, email: `${sub}@example.test` }), { jar });
}

const STALE = REAUTH_WINDOW_S + 60;

describe('5-minute re-authentication', () => {
  it('a stale session cannot link a provider, change the password or unlink', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await ageSessions(userId, STALE);
    const attempts = [
      await linkGoogle(jar),
      await call('/api/auth/change-password', { jar, json: { currentPassword: PASSWORD, newPassword: 'another passphrase' } }),
      await call('/api/auth/unlink-account', { jar, json: { accountId: 'any' } }),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    }
    const accounts = await env.DB.prepare('SELECT providerId FROM account WHERE userId = ?').bind(userId).all();
    expect(accounts.results).toEqual([{ providerId: 'credential' }]);
    expect(await signIn(new CookieJar(), (await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>())!.email)).toBe(userId);
  });

  it('signing in again opens the window', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    await ageSessions(userId, STALE);
    await signIn(jar, email); // re-authentication: a new session
    const res = await call('/api/auth/change-password', { jar, json: { currentPassword: PASSWORD, newPassword: 'another passphrase' } });
    expect(res.status).toBe(200);
  });

  it('a just-under-five-minutes-old session is still fresh', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await ageSessions(userId, REAUTH_WINDOW_S - 30);
    const landed = await linkGoogle(jar);
    expect(landed.status).toBe(302);
    expect(new URL(landed.headers.get('location')!, env.ISSUER).pathname).toBe('/done');
  });

  it('anonymous users link without re-authentication (they have no other credential)', async () => {
    const { jar, userId } = await anonymous();
    await ageSessions(userId, STALE);
    const landed = await linkGoogle(jar);
    expect(new URL(landed.headers.get('location')!, env.ISSUER).pathname).toBe('/done');
  });
});

describe('anonymous Email/Password upgrade (/link/email)', () => {
  it('reverts the email when creating the credential fails, leaving the anonymous user unchanged', async () => {
    const { jar, userId } = await anonymous();
    const before = await env.DB.prepare('SELECT email, emailVerified, isAnonymous FROM "user" WHERE id = ?').bind(userId).first();
    const failing = vi.spyOn(auth().api, 'setPassword').mockRejectedValueOnce(new Error('simulated D1 failure'));

    const email = uniqueEmail('upgrade');
    const res = await call('/link/email', { jar, json: { email, password: PASSWORD } });
    failing.mockRestore();
    expect(res.status).toBe(500);
    expect(await env.DB.prepare('SELECT email, emailVerified, isAnonymous FROM "user" WHERE id = ?').bind(userId).first()).toEqual(before);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM account WHERE userId = ?').bind(userId).first<{ n: number }>())!.n).toBe(0);

    // The address was not left claimed: the same upgrade succeeds on retry.
    const retry = await call('/link/email', { jar, json: { email, password: PASSWORD } });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ user_id: userId });
  });

  it('a successful upgrade mails a verification link and is audited as a link', async () => {
    const { jar, userId } = await anonymous();
    const email = uniqueEmail('upgrade');
    expect((await call('/link/email', { jar, json: { email, password: PASSWORD } })).status).toBe(200);
    expect((await outbox(email)).map((m) => m.template)).toEqual(['verify_email']);
    expect(await auditRows('auth.identity_linked', userId)).toEqual([
      expect.objectContaining({ actor_type: 'user', actor_id: userId, metadata: { provider: 'credential', upgraded_anonymous: true } }),
    ]);
  });

  it('registered users cannot use it', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const res = await call('/link/email', { jar, json: { email: uniqueEmail(), password: PASSWORD } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('link / unlink audit', () => {
  it('a registered user linking Google and unlinking it again is audited; registration is not', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    expect(await auditRows('auth.identity_linked', userId)).toEqual([]);

    expect((await linkGoogle(jar)).status).toBe(302);
    expect(await auditRows('auth.identity_linked', userId)).toEqual([
      expect.objectContaining({ metadata: { provider: 'google', upgraded_anonymous: false } }),
    ]);

    const googleAccount = await env.DB.prepare(`SELECT id FROM account WHERE userId = ? AND providerId = 'google'`).bind(userId).first<{ id: string }>();
    const unlink = await call('/api/auth/unlink-account', { jar, json: { accountId: googleAccount!.id } });
    expect(unlink.status).toBe(200);
    expect(await auditRows('auth.identity_unlinked', userId)).toEqual([
      expect.objectContaining({ actor_type: 'user', actor_id: userId, metadata: { provider: 'google' } }),
    ]);
  });

  it('the last remaining credential cannot be unlinked', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const credential = await env.DB.prepare('SELECT id FROM account WHERE userId = ?').bind(userId).first<{ id: string }>();
    const res = await call('/api/auth/unlink-account', { jar, json: { accountId: credential!.id } });
    expect(res.status).toBe(400);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM account WHERE userId = ?').bind(userId).first<{ n: number }>())!.n).toBe(1);
    expect(await auditRows('auth.identity_unlinked', userId)).toEqual([]);
  });
});
