// Operator setup (src/setup.ts, PRD §19.9, §20.3): the first administrator and the console client at install
// time, and administrator password recovery, behind the SETUP_TOKEN secret. The tests of this file run
// in order and share one database: the first ones need a platform without an owner.
import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { decodeJwt, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { CookieJar, auditRows, call, signIn, signUp, uniqueEmail, useEnv } from './helpers.ts';
import { CONSOLE, consoleToken, enrollTotp, startConsoleLogin } from './mfa.ts';
import type { TokenResponse } from './oauth-flow.ts';

const TOKEN = 'test-only-setup-token';
const ADMIN_PASSWORD = 'Gen3rated-Admin-Passw0rd';

const setupCall = (path: string, json: unknown, token: string | null = TOKEN) =>
  call(`/setup${path}`, { json, headers: token === null ? {} : { authorization: `Bearer ${token}` } });

const install = (email: string, password = ADMIN_PASSWORD, redirectUris = [CONSOLE.redirectUri]) =>
  setupCall('/install', { admin_email: email, admin_password: password, console_redirect_uris: redirectUris });

const owners = async () =>
  (await env.DB.prepare(`SELECT user_id FROM team_members WHERE role = 'owner'`).all<{ user_id: string }>()).results.map((r) => r.user_id);

const consoleRedirectUris = async () =>
  (await env.DB.prepare('SELECT redirectUris FROM oauthClient WHERE clientId = ?').bind(CONSOLE_CLIENT_ID).first<{ redirectUris: string }>())
    ?.redirectUris ?? '';

/** Console sign-in with a password (TOTP is optional by default): the token claims, or the page it stopped at. */
async function consoleSignIn(email: string, password: string): Promise<{ claims?: JWTPayload; stoppedAt?: string }> {
  const { verifier, next } = await startConsoleLogin(new CookieJar(), email, password);
  if (`${next.origin}${next.pathname}` !== CONSOLE.redirectUri) return { stoppedAt: next.pathname };
  const res = await consoleToken(next, verifier);
  return { claims: decodeJwt((await res.json<TokenResponse>()).access_token) };
}

const passwordSignIn = (email: string, password: string) => call('/api/auth/sign-in/email', { json: { email, password } });

afterEach(() => useEnv(null));

describe('operator setup', () => {
  const adminEmail = uniqueEmail('admin');
  let adminId: string;

  it('needs the exact setup token; without SETUP_TOKEN the routes do not exist', async () => {
    expect((await setupCall('/install', {}, null)).status).toBe(401);
    expect((await setupCall('/install', {}, `${TOKEN}x`)).status).toBe(401);
    expect((await setupCall('/reset-admin', {}, 'wrong')).status).toBe(401);
    useEnv({ SETUP_TOKEN: '' });
    expect((await setupCall('/install', {}, '')).status).toBe(404);
    expect(await owners()).toEqual([]);
  });

  it('rejects a short password and never promotes an existing account', async () => {
    expect((await install(uniqueEmail('admin'), 'short')).status).toBe(400);
    const { email } = await signUp(new CookieJar());
    expect((await install(email)).status).toBe(409);
    expect(await owners()).toEqual([]);
  });

  it('install creates a verified owner and the console client; the admin signs in to the console with the password', async () => {
    const res = await install(adminEmail.toUpperCase());
    expect(res.status).toBe(201);
    const body = await res.json<{ admin: string; user_id: string; console_client: { clientId: string; resource: string } }>();
    expect(body.admin).toBe('created');
    expect(body.console_client).toEqual({ clientId: CONSOLE_CLIENT_ID, resource: CONSOLE_AUDIENCE });
    adminId = body.user_id;
    expect(await owners()).toEqual([adminId]);
    const user = await env.DB.prepare('SELECT email, emailVerified FROM "user" WHERE id = ?').bind(adminId).first<{ email: string; emailVerified: number }>();
    expect(user).toEqual({ email: adminEmail, emailVerified: 1 });
    expect(await auditRows('ops.owner_granted', adminId)).toHaveLength(1);

    const { claims } = await consoleSignIn(adminEmail, ADMIN_PASSWORD);
    expect(claims?.sub).toBe(adminId);
    expect(claims?.aud).toContain(CONSOLE_AUDIENCE);
  });

  it('install again only updates the console redirect URIs', async () => {
    const res = await install(uniqueEmail('second'), 'Another-Passw0rd-123', ['https://console.example.test/', CONSOLE.redirectUri]);
    expect(res.status).toBe(200);
    expect((await res.json<{ admin: string }>()).admin).toBe('exists');
    expect(await owners()).toEqual([adminId]);
    expect(await consoleRedirectUris()).toContain('https://console.example.test/');
  });

  it('reset-admin sets a new password, signs the admin out everywhere and can remove TOTP', async () => {
    const jar = new CookieJar();
    await signIn(jar, adminEmail, ADMIN_PASSWORD);
    await enrollTotp(jar, '', ADMIN_PASSWORD);
    expect((await consoleSignIn(adminEmail, ADMIN_PASSWORD)).stoppedAt).toBe('/two-factor');

    await env.DB.prepare(`INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp) VALUES ('pk_test', 'x', ?, 'cred_test', 0, 'singleDevice', 0)`).bind(adminId).run();
    const next = 'Rec0vered-Admin-Passw0rd';
    const res = await setupCall('/reset-admin', { email: adminEmail, password: next, disable_2fa: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: adminId, disabled_2fa: true });

    expect(await (await call('/api/auth/get-session', { jar })).json()).toBeNull();
    expect((await passwordSignIn(adminEmail, ADMIN_PASSWORD)).status).toBe(401);
    expect((await consoleSignIn(adminEmail, next)).claims?.sub).toBe(adminId);
    const user = await env.DB.prepare('SELECT twoFactorEnabled FROM "user" WHERE id = ?').bind(adminId).first<{ twoFactorEnabled: number }>();
    expect(user!.twoFactorEnabled).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?').bind(adminId).first<{ n: number }>())!.n).toBe(0);
    expect(await auditRows('auth.admin_password_reset', adminId)).toHaveLength(1);
  });

  it('reset-admin refuses accounts that are not platform team members', async () => {
    const { email } = await signUp(new CookieJar());
    expect((await setupCall('/reset-admin', { email, password: 'Whatever-Passw0rd-1' })).status).toBe(404);
    expect((await setupCall('/reset-admin', { email: uniqueEmail('nobody'), password: 'Whatever-Passw0rd-1' })).status).toBe(404);
  });
});
