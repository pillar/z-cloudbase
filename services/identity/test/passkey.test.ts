// Passkeys (PRD §21.3) with a software authenticator (test/webauthn.ts): registration on the account,
// sign-in (also inside an authorization request), user verification required on both ceremonies, the
// relying party pinned to the issuer, audit, removal, and the console MFA rule (a passkey sign-in counts).
import { CONSOLE_AUDIENCE } from '@z-cloudbase/contracts';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerConsoleClient } from '../src/clients.ts';
import { IdentityRpc } from '../src/index.ts';
import { asSystem } from '../src/system.ts';
import { CookieJar, auditRows, auth, call, signUp, useEnv } from './helpers.ts';
import { CONSOLE, consoleToken, startConsoleLogin } from './mfa.ts';
import { authorizeUrl, exchangeCode, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';
import { SoftAuthenticator } from './webauthn.ts';

const ISSUER = new URL(env.ISSUER);
const location = (res: Response) => new URL(res.headers.get('location')!, env.ISSUER);
const session = async (jar: CookieJar) =>
  (await call('/api/auth/get-session', { jar })).json<{ user: { id: string }; session: { twoFactorVerifiedAt?: string | null } } | null>();
const passkeyCount = async (userId: string) =>
  (await env.DB.prepare('SELECT count(*) AS n FROM passkey WHERE userId = ?').bind(userId).first<{ n: number }>())!.n;

beforeAll(async () => {
  await asSystem(() => registerConsoleClient(auth(), new Headers(), [CONSOLE.redirectUri]));
  await setupClients([{ productId: 'passkey_app', env: 'prod' }]);
});
afterEach(() => useEnv(null));

/** Registration through the engine endpoints the page script uses. */
async function register(jar: CookieJar, device: SoftAuthenticator, o: { uv?: boolean; origin?: string } = {}) {
  const opts = await call('/api/auth/passkey/generate-register-options', { jar });
  if (opts.status !== 200) return opts;
  const options = await opts.json<{ challenge: string; user: { id: string }; rp: { id: string }; authenticatorSelection: { userVerification: string } }>();
  return call('/api/auth/passkey/verify-registration', { jar, json: { response: await device.create(options, o), name: 'Laptop' } });
}

/** Sign-in through the engine endpoints; `oauthQuery` continues an authorization request. */
async function passkeySignIn(jar: CookieJar, device: SoftAuthenticator, o: { uv?: boolean; origin?: string; oauthQuery?: string } = {}) {
  const options = await (await call('/api/auth/passkey/generate-authenticate-options', { jar })).json<{ challenge: string }>();
  return call('/api/auth/passkey/verify-authentication', {
    jar,
    json: { response: await device.get(options, o), ...(o.oauthQuery ? { oauth_query: o.oauthQuery } : {}) },
  });
}

async function userWithPasskey() {
  const jar = new CookieJar();
  const u = await signUp(jar);
  const device = new SoftAuthenticator(ISSUER.hostname, ISSUER.origin);
  const res = await register(jar, device);
  expect(res.status).toBe(200);
  return { ...u, jar, device };
}

describe('passkey registration', () => {
  it('pins the relying party to the issuer and requires user verification', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const options = await (await call('/api/auth/passkey/generate-register-options', { jar })).json<{
      rp: { id: string; name: string };
      authenticatorSelection: { userVerification: string };
    }>();
    expect(options.rp.id).toBe(ISSUER.hostname);
    expect(options.authenticatorSelection.userVerification).toBe('required');
  });

  it('adds a passkey for a signed-in user and audits it', async () => {
    const { userId } = await userWithPasskey();
    expect(await passkeyCount(userId)).toBe(1);
    const [row] = await auditRows('auth.passkey_added', userId);
    expect(row).toMatchObject({ actor_type: 'user', actor_id: userId });
    expect(row!.metadata.passkey_id).toMatch(/.+/);
  });

  it('refuses without a session, for guests, without user verification and from another origin', async () => {
    expect((await call('/api/auth/passkey/generate-register-options')).status).toBe(401);

    const guest = new CookieJar();
    await call('/api/auth/sign-in/anonymous', { jar: guest, json: {} });
    expect((await call('/api/auth/passkey/generate-register-options', { jar: guest })).status).toBe(403);

    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const device = new SoftAuthenticator(ISSUER.hostname, ISSUER.origin);
    expect((await register(jar, device, { uv: false })).status).toBe(400);
    expect((await register(jar, device, { origin: 'https://evil.example' })).status).toBeGreaterThanOrEqual(400);
    expect(await passkeyCount(userId)).toBe(0);
  });

  it('needs a recent sign-in (5 minutes)', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await env.DB.prepare('UPDATE session SET createdAt = ?, updatedAt = ? WHERE userId = ?')
      .bind(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 3600_000).toISOString(), userId).run();
    expect((await call('/api/auth/passkey/generate-register-options', { jar })).status).toBe(403);
  });
});

describe('passkey sign-in', () => {
  it('signs in with a user-verified assertion; the session counts as second factor', async () => {
    const { userId, device } = await userWithPasskey();
    const jar = new CookieJar();
    const res = await passkeySignIn(jar, device);
    expect(res.status).toBe(200);
    const s = await session(jar);
    expect(s?.user.id).toBe(userId);
    expect(s?.session.twoFactorVerifiedAt).toBeTruthy();
  });

  it('refuses an assertion without user verification or from another origin, and unknown credentials', async () => {
    const { device } = await userWithPasskey();
    const jar = new CookieJar();
    expect((await passkeySignIn(jar, device, { uv: false })).status).toBe(401);
    expect((await passkeySignIn(jar, device, { origin: 'https://evil.example' })).status).toBe(400);
    const stranger = new SoftAuthenticator(ISSUER.hostname, ISSUER.origin);
    await stranger.create({ challenge: 'x', user: { id: 'eA' } }); // never registered with the server
    expect((await passkeySignIn(jar, stranger)).status).toBe(401);
    expect(await session(jar)).toBeNull();
  });

  it('a challenge works once', async () => {
    const { device } = await userWithPasskey();
    const jar = new CookieJar();
    const options = await (await call('/api/auth/passkey/generate-authenticate-options', { jar })).json<{ challenge: string }>();
    const response = await device.get(options);
    expect((await call('/api/auth/passkey/verify-authentication', { jar, json: { response } })).status).toBe(200);
    const replay = await device.get(options);
    expect((await call('/api/auth/passkey/verify-authentication', { jar, json: { response: replay } })).status).toBe(400);
  });

  it('continues an authorization request and the product receives a code', async () => {
    const { userId, device } = await userWithPasskey();
    const { verifier, challenge } = await pkcePair();
    const state = randomToken();
    const browser = new CookieJar();
    const start = await call(authorizeUrl({ productId: 'passkey_app', env: 'prod', state, nonce: randomToken(), challenge }), { jar: browser });
    const login = location(start);
    expect(login.pathname).toBe('/login');
    const page = await (await call(`${login.pathname}${login.search}`, { jar: browser })).text();
    expect(page).toContain('data-passkey-signin');
    const res = await passkeySignIn(browser, device, { oauthQuery: login.search.slice(1) });
    expect(res.status).toBe(200);
    const { url } = await res.json<{ url: string }>();
    const callback = new URL(url);
    expect(callback.searchParams.get('state')).toBe(state);
    const tokens = await (await exchangeCode('passkey_app', 'prod', callback.searchParams.get('code')!, verifier)).json<TokenResponse>();
    expect(decodeJwt(tokens.access_token)).toMatchObject({ sub: userId, pid: 'passkey_app' });
  });

  it('serves the ceremony script from the identity origin', async () => {
    const res = await call('/assets/passkey.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toContain('navigator.credentials.get');
  });
});

describe('passkeys and the console MFA requirement (REQUIRE_ADMIN_2FA=true)', () => {
  it('an admin with a passkey (no TOTP) verifies with it on the second-factor page and reaches the console', async () => {
    const { email, userId, device } = await userWithPasskey();
    useEnv({ REQUIRE_ADMIN_2FA: 'true' });
    const jar = new CookieJar();
    const { verifier, next } = await startConsoleLogin(jar, email);
    expect(next.pathname).toBe('/two-factor');
    const ret = next.searchParams.get('return')!;
    expect(await (await call(`${next.pathname}${next.search}`, { jar })).text()).toContain('data-passkey-signin');
    expect((await passkeySignIn(jar, device)).status).toBe(200);
    const resume = await call(`/passkey/continue?${new URLSearchParams({ return: ret })}`, { jar });
    const authorize = location(resume);
    expect(authorize.pathname).toBe('/api/auth/oauth2/authorize');
    const cb = location(await call(`${authorize.pathname}${authorize.search}`, { jar }));
    const token = await consoleToken(cb, verifier);
    expect(token.status).toBe(200);
    const claims = decodeJwt((await token.json<TokenResponse>()).access_token);
    expect(claims).toMatchObject({ sub: userId });
    expect(claims.aud).toContain(CONSOLE_AUDIENCE);
  });

  it('without TOTP or a passkey the admin is still sent to enrollment', async () => {
    const { email } = await signUp(new CookieJar());
    useEnv({ REQUIRE_ADMIN_2FA: 'true' });
    const { next } = await startConsoleLogin(new CookieJar(), email);
    expect(next.pathname).toBe('/two-factor/setup');
  });

  it('/passkey/continue only resumes this issuer\'s authorization endpoint', async () => {
    for (const ret of ['https://evil.example/x', '//evil.example/x', '/account/deletion']) {
      expect(location(await call(`/passkey/continue?${new URLSearchParams({ return: ret })}`)).toString()).toBe(`${env.ISSUER}/account`);
    }
  });
});

describe('removing passkeys', () => {
  it('needs a recent sign-in, removes only own passkeys and is audited', async () => {
    const { userId, jar } = await userWithPasskey();
    const id = (await env.DB.prepare('SELECT id FROM passkey WHERE userId = ?').bind(userId).first<{ id: string }>())!.id;

    const other = new CookieJar();
    await signUp(other);
    const foreign = await call('/account/passkeys/delete', { jar: other, form: { id } });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await passkeyCount(userId)).toBe(1);

    await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?').bind(new Date(Date.now() - 3600_000).toISOString(), userId).run();
    const stale = await call('/account/passkeys/delete', { jar, form: { id } });
    expect(location(stale).pathname).toBe('/login');
    expect(await passkeyCount(userId)).toBe(1);

    await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?').bind(new Date().toISOString(), userId).run();
    const ok = await call('/account/passkeys/delete', { jar, form: { id } });
    expect(location(ok).pathname).toBe('/account');
    expect(await passkeyCount(userId)).toBe(0);
    expect((await auditRows('auth.passkey_removed', userId))[0]!.metadata).toEqual({ passkey_id: id });
  });

  it('account deletion removes the passkeys with the other credentials', async () => {
    const { userId } = await userWithPasskey();
    await new IdentityRpc(createExecutionContext(), env).deleteUserIdentity({ userId, reason: 'test' });
    expect(await passkeyCount(userId)).toBe(0);
  });

  it('the account page lists passkeys; PASSKEYS=false hides the feature', async () => {
    const { jar } = await userWithPasskey();
    expect(await (await call('/account', { jar })).text()).toContain('Laptop');
    useEnv({ PASSKEYS: 'false' });
    expect(await (await call('/account', { jar })).text()).not.toContain('data-passkey-register');
    expect((await call('/api/auth/passkey/generate-authenticate-options')).status).toBe(404);
  });
});
