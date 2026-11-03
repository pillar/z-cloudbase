// Admin MFA (PRD §19.9, §19.11). By default TOTP is optional for administrators, but an admin who
// enabled it must pass it in the current identity session. With REQUIRE_ADMIN_2FA=true authorizing
// the console client also needs TOTP enrolled; the identity domain's MFA pages (enrollment with
// backup codes shown once, or the code prompt) come first and then resume the authorization.
// Product clients are unaffected.
import { CONSOLE_AUDIENCE } from '@z-cloudbase/contracts';
import { totp } from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConsoleClient } from '../src/clients.ts';
import { asSystem } from '../src/system.ts';
import { CookieJar, auditRows, auth, call, signIn, signUp, useEnv } from './helpers.ts';
import { CONSOLE, consoleToken, enrollTotp, startConsoleLogin } from './mfa.ts';
import { authorizeUrl, pkcePair, randomToken, setupClients, ssoToProduct, type TokenResponse } from './oauth-flow.ts';

const location = (res: Response) => new URL(res.headers.get('location')!, env.ISSUER);
const session = async (jar: CookieJar) => (await call('/api/auth/get-session', { jar })).json<{ user: { id: string } } | null>();

async function sessionMarks(userId: string) {
  const { results } = await env.DB.prepare('SELECT twoFactorVerifiedAt AS at FROM session WHERE userId = ?').bind(userId).all<{ at: unknown }>();
  return results.map((r) => r.at);
}

/** A signed-up user who enrolled TOTP from their own session (e.g. on the account page). */
async function enrolledUser() {
  const jar = new CookieJar();
  const u = await signUp(jar);
  const { secret, backupCodes } = await enrollTotp(jar);
  return { ...u, jar, secret, backupCodes };
}

describe('RFC 6238 test helper', () => {
  it('matches the RFC test vectors (SHA-1)', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    expect(await totp(secret, 59_000, { digits: 8 })).toBe('94287082');
    expect(await totp(secret, 1_111_111_109_000, { digits: 8 })).toBe('07081804');
  });
});

beforeAll(async () => {
  await asSystem(() => registerConsoleClient(auth(), new Headers(), [CONSOLE.redirectUri]));
  await setupClients([{ productId: 'product_a', env: 'prod' }]);
});

describe('default deployment: TOTP is optional for administrators', () => {
  it('without TOTP the console login goes straight back to the console with a code', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const jar = new CookieJar();
    const { verifier, state, next } = await startConsoleLogin(jar, email);
    expect(`${next.origin}${next.pathname}`).toBe(CONSOLE.redirectUri);
    expect(next.searchParams.get('state')).toBe(state);
    const token = await consoleToken(next, verifier);
    expect(token.status).toBe(200);
    expect(decodeJwt((await token.json<TokenResponse>()).access_token).sub).toBe(userId);
  });

  it('an administrator who enabled TOTP still has to pass it, also in a session from before the enrollment', async () => {
    const early = new CookieJar();
    const { email } = await signUp(early);
    const enrolling = new CookieJar();
    await signIn(enrolling, email);
    await enrollTotp(enrolling);

    expect((await startConsoleLogin(new CookieJar(), email)).next.pathname).toBe('/two-factor');
    const { challenge } = await pkcePair();
    const res = await call(
      authorizeUrl({ productId: '', env: 'prod', state: randomToken(), nonce: randomToken(), challenge, client: CONSOLE, resource: CONSOLE_AUDIENCE }),
      { jar: early },
    );
    expect(location(res).pathname).toBe('/two-factor');
  });
});

describe('REQUIRE_ADMIN_2FA=true: console authorization requires TOTP', () => {
  beforeAll(() => useEnv({ REQUIRE_ADMIN_2FA: 'true' }));
  afterAll(() => useEnv(null));

  it('without TOTP: the login leads to enrollment (backup codes shown once), then the authorization resumes with a code', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const jar = new CookieJar();
    const { verifier, state, next } = await startConsoleLogin(jar, email);
    expect(next.pathname).toBe('/two-factor/setup');
    const ret = next.searchParams.get('return')!;
    expect(ret.startsWith('/api/auth/oauth2/authorize?')).toBe(true);
    expect(new URLSearchParams(ret.split('?')[1]).get('client_id')).toBe(CONSOLE.id);
    // The resumed request is the authorization only: nothing of the sign-in form leaks into the URL.
    expect(next.toString()).not.toMatch(/password|horse|email|oauth_query|sig=/i);
    expect(await (await call(`${next.pathname}${next.search}`, { jar })).text()).toContain('name="password"');

    // A wrong first code does not turn TOTP on.
    const start = await call('/two-factor/setup', { jar, form: { password: 'wrong password!', return: ret } });
    expect(start.status).toBe(400);
    const enrolled = await enrollTotp(jar, ret);
    expect(enrolled.backupCodes).toHaveLength(10);
    expect(enrolled.page).toContain('not shown again');
    expect(`${enrolled.next.pathname}${enrolled.next.search}`).toBe(ret);

    const back = await call(ret, { jar });
    expect(back.status).toBe(302);
    const cb = location(back);
    expect(`${cb.origin}${cb.pathname}`).toBe(CONSOLE.redirectUri);
    expect(cb.searchParams.get('state')).toBe(state);
    const token = await consoleToken(cb, verifier);
    expect(token.status).toBe(200);
    const claims = decodeJwt((await token.json<TokenResponse>()).access_token);
    expect(claims.sub).toBe(userId);
    expect(claims.aud).toContain(CONSOLE_AUDIENCE);

    const user = await env.DB.prepare('SELECT twoFactorEnabled FROM "user" WHERE id = ?').bind(userId).first<{ twoFactorEnabled: number }>();
    expect(user!.twoFactorEnabled).toBe(1);
    expect(await auditRows('auth.mfa_enabled', userId)).toHaveLength(1);
  });

  it('a wrong enrollment code keeps TOTP off and the authorization blocked', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const jar = new CookieJar();
    const { next } = await startConsoleLogin(jar, email);
    const ret = next.searchParams.get('return')!;
    expect((await call('/two-factor/setup', { jar, form: { password: 'correct horse battery staple', return: ret } })).status).toBe(200);
    expect((await call('/two-factor/setup/confirm', { jar, form: { code: '000000', return: ret } })).status).toBe(400);
    const again = await call(ret, { jar });
    expect(location(again).pathname).toBe('/two-factor/setup');
    const user = await env.DB.prepare('SELECT twoFactorEnabled FROM "user" WHERE id = ?').bind(userId).first<{ twoFactorEnabled: number }>();
    expect(user!.twoFactorEnabled).toBe(0);
  });

  it('a direct authorize navigation with a session but no TOTP is redirected to enrollment', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const { challenge } = await pkcePair();
    const res = await call(
      authorizeUrl({ productId: '', env: 'prod', state: randomToken(), nonce: randomToken(), challenge, client: CONSOLE, resource: CONSOLE_AUDIENCE }),
      { jar },
    );
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/two-factor/setup');
  });

  it('with TOTP: the password sign-in asks for the code before any session exists, then issues the console code', async () => {
    const u = await enrolledUser();
    const jar = new CookieJar();
    const { verifier, next } = await startConsoleLogin(jar, u.email);
    expect(next.pathname).toBe('/two-factor');
    expect(await session(jar)).toBeNull();
    const oauthQuery = next.searchParams.get('oauth_query')!;

    expect((await call('/two-factor', { jar, form: { code: '000000', oauth_query: oauthQuery, return: '' } })).status).toBe(401);
    expect(await session(jar)).toBeNull();
    const ok = await call('/two-factor', { jar, form: { code: await totp(u.secret), oauth_query: oauthQuery, return: '' } });
    expect(ok.status).toBe(302);
    expect((await consoleToken(location(ok), verifier)).status).toBe(200);
    expect((await session(jar))!.user.id).toBe(u.userId);
  });

  it('a backup code works once', async () => {
    const u = await enrolledUser();
    const code = u.backupCodes[0]!;

    const first = new CookieJar();
    const a = await startConsoleLogin(first, u.email);
    const used = await call('/two-factor', { jar: first, form: { code, oauth_query: a.next.searchParams.get('oauth_query')!, return: '' } });
    expect(used.status).toBe(302);
    expect((await consoleToken(location(used), a.verifier)).status).toBe(200);

    const second = new CookieJar();
    const b = await startConsoleLogin(second, u.email);
    const reused = await call('/two-factor', { jar: second, form: { code, oauth_query: b.next.searchParams.get('oauth_query')!, return: '' } });
    expect(reused.status).toBe(401);
    expect(await session(second)).toBeNull();
  });

  it('a session that has not passed the second factor (signed in before enrollment) must step up', async () => {
    const early = new CookieJar();
    const { email, userId } = await signUp(early);
    const enrolling = new CookieJar();
    await signIn(enrolling, email);
    const { secret } = await enrollTotp(enrolling);

    const { verifier, challenge } = await pkcePair();
    const res = await call(
      authorizeUrl({ productId: '', env: 'prod', state: randomToken(), nonce: randomToken(), challenge, client: CONSOLE, resource: CONSOLE_AUDIENCE }),
      { jar: early },
    );
    const next = location(res);
    expect(next.pathname).toBe('/two-factor');
    const ret = next.searchParams.get('return')!;
    expect((await call('/two-factor', { jar: early, form: { code: '000000', oauth_query: '', return: ret } })).status).toBe(401);

    const stepped = await call('/two-factor', { jar: early, form: { code: await totp(secret), oauth_query: '', return: ret } });
    expect(`${location(stepped).pathname}${location(stepped).search}`).toBe(ret);
    const cb = location(await call(ret, { jar: early }));
    expect((await consoleToken(cb, verifier)).status).toBe(200);
    expect((await sessionMarks(userId)).every(Boolean)).toBe(true);
  });

  it('product clients are unaffected: no TOTP, or a session without the second factor, still gets a product code', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    expect((await ssoToProduct(jar, 'product_a')).access_token).toBeTruthy();

    const early = new CookieJar();
    const { email } = await signUp(early);
    const enrolling = new CookieJar();
    await signIn(enrolling, email);
    await enrollTotp(enrolling);
    expect((await ssoToProduct(early, 'product_a')).access_token).toBeTruthy();
  });

  it('the MFA pages resume only authorization requests of this issuer', async () => {
    const u = await enrolledUser();
    for (const ret of ['https://evil.example/api/auth/oauth2/authorize?x=1', '//evil.example/api/auth/oauth2/authorize', '/account/deletion']) {
      const res = await call(`/two-factor/setup?${new URLSearchParams({ return: ret })}`, { jar: u.jar });
      expect(res.headers.get('location')).toBe('/account');
    }
    const own = await call(`/two-factor/setup?${new URLSearchParams({ return: '/api/auth/oauth2/authorize?client_id=x' })}`, { jar: u.jar });
    expect(own.headers.get('location')).toBe('/api/auth/oauth2/authorize?client_id=x');
  });

  it('disabling TOTP needs the password and is audited', async () => {
    const u = await enrolledUser();
    expect((await call('/api/auth/two-factor/disable', { jar: u.jar, json: { password: 'wrong password!' } })).status).toBe(400);
    expect((await call('/api/auth/two-factor/disable', { jar: u.jar, json: { password: 'correct horse battery staple' } })).status).toBe(200);
    expect(await auditRows('auth.mfa_disabled', u.userId)).toHaveLength(1);
  });
});
