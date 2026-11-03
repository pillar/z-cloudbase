// Platform user management on the identity worker (PRD §21.5): bans at the session-creation layer and at
// token issuance / refresh, support impersonation (TOTP-confirmed, act claim, restrictions, stop, expiry),
// and the webhook events emitted here (user.joined, user.upgraded, user.banned / user.unbanned).
import { AUTH_RATE_PER_IP_PER_MIN, CONSOLE_AUDIENCE, IMPERSONATION_REQUEST_TTL_S, clientId, newId, type Environment } from '@z-cloudbase/contracts';
import { verifyWebhookSignature } from '@z-cloudbase/security';
import { totp } from '@z-cloudbase/testing';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityRpc } from '../src/index.ts';
import { setWebhookFetch } from '../src/webhooks.ts';
import { CookieJar, PASSWORD, auditRows, call, seedProduct, signIn, signUp, uniqueEmail } from './helpers.ts';
import { CONSOLE, enrollTotp } from './mfa.ts';
import { authorizeUrl, pkcePair, randomToken, refresh, setupClients, ssoToProduct } from './oauth-flow.ts';

const rpc = () => new IdentityRpc(createExecutionContext(), env);
const location = (res: Response) => new URL(res.headers.get('location')!, env.ISSUER);

const P = 'useradm_a';
const ENV: Environment = 'prod';

async function seedEnv(productId: string, e: Environment) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO product_environments (id, product_id, env, publishable_key, user_key_salt, storage_quota_bytes, max_object_bytes, created_at)
     VALUES (?, ?, ?, ?, 'salt', 1, 1, ?)`,
  ).bind(clientId(productId, e), productId, e, `pk_${e}_${crypto.randomUUID()}`, Date.now()).run();
}

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
async function seedEndpoint(productId: string, e: Environment, types: string[]) {
  const id = newId('whe');
  await env.DB.prepare(
    `INSERT INTO webhook_endpoints (id, product_env_id, url, event_types, enabled, secret, created_by, created_at, updated_at)
     VALUES (?, ?, 'https://hooks.example.test/in', ?, 1, ?, 'usr_test', ?, ?)`,
  ).bind(id, clientId(productId, e), JSON.stringify(types), SECRET, Date.now(), Date.now()).run();
  return id;
}

/** Captures webhook POSTs (signature checked) instead of sending them. */
const received: Array<{ type: string; product_id: string; env: string; data: Record<string, unknown> }> = [];
function captureWebhooks() {
  setWebhookFetch(async (_url, init) => {
    const body = String(init.body);
    await verifyWebhookSignature({ secret: SECRET, headers: new Headers(init.headers), body });
    received.push(JSON.parse(body));
    return new Response('ok');
  });
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function owner() {
  const jar = new CookieJar();
  const { email, userId } = await signUp(jar);
  await env.DB.prepare(`INSERT INTO team_members (id, user_id, role, product_id, created_by, created_at) VALUES (?, ?, 'owner', NULL, 'test', ?)`)
    .bind(newId('tm'), userId, Date.now()).run();
  const { secret } = await enrollTotp(jar);
  return { jar, email, userId, secret };
}

async function requestImpersonation(actorId: string, targetId: string, reason = 'ticket #42: cannot see purchases') {
  const id = newId('imp');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO impersonations (id, actor_id, target_id, reason, status, created_at, request_expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(id, actorId, targetId, reason, now, now + IMPERSONATION_REQUEST_TTL_S * 1000).run();
  return id;
}

async function sessionOf(jar: CookieJar) {
  return (await call('/api/auth/get-session', { jar })).json<{ user: { id: string }; session: { impersonatedBy?: string | null } } | null>();
}

beforeAll(async () => {
  await setupClients([{ productId: P, env: ENV }, { productId: P, env: 'dev' }]);
  await seedEnv(P, ENV);
  await seedEnv(P, 'dev');
});

// Deliveries never leave the test: every webhook POST of this file is captured (and its signature checked).
beforeAll(() => captureWebhooks());
afterAll(() => setWebhookFetch(null));

describe('ban (PRD §21.5.1)', () => {
  it('revokes sessions and product refresh tokens; no sign-in, authorization or refresh while banned; unban restores sign-in', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    const tokens = await ssoToProduct(jar, P, ENV);
    const admin = await owner();

    const banned = await rpc().setUserBan({ userId, actorId: admin.userId, ban: { reason: 'fraud', expiresAt: null } });
    expect(banned).toMatchObject({ changed: true, banned: true, expires_at: null });
    expect(await sessionOf(jar)).toBeNull();
    // The refresh token of a banned user is rejected (it was also deleted).
    const r = await refresh(P, ENV, tokens.refresh_token!);
    expect(r.status).toBe(400);
    expect((await r.json<{ error: string }>()).error).toBe('invalid_grant');

    // Every sign-in method creates a session through the hook: the engine endpoint and the login form both say why.
    const signin = await call('/api/auth/sign-in/email', { jar, json: { email, password: PASSWORD } });
    expect(signin.status).toBe(403);
    expect(await signin.json()).toMatchObject({ code: 'BANNED_USER', message: expect.stringContaining('banned') });
    const form = await call('/login', { jar: new CookieJar(), form: { email, password: PASSWORD, oauth_query: '' } });
    expect(form.status).toBe(403);
    expect(await form.text()).toContain('This account has been banned');
    // Social sign-in lands on /login?error=… from the engine's callback.
    expect(await (await call('/login?error=BANNED_USER', { jar: new CookieJar(), headers: { 'accept-language': 'en' } })).text()).toContain('This account has been banned and cannot sign in.');

    const audit = await auditRows('user.ban', userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'user', actor_id: admin.userId, metadata: { reason: 'fraud', expires_at: null } });

    expect(await rpc().setUserBan({ userId, actorId: admin.userId, ban: null })).toMatchObject({ changed: true, banned: false });
    expect(await rpc().setUserBan({ userId, actorId: admin.userId, ban: null })).toMatchObject({ changed: false });
    expect(await auditRows('user.unban', userId)).toHaveLength(1);
    await signIn(new CookieJar(), email);
  });

  it('refuses an authorization code issued before the ban, and lets an expired ban lapse', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    const { challenge } = await pkcePair();
    const cb = location(await call(authorizeUrl({ productId: P, env: ENV, state: randomToken(), nonce: randomToken(), challenge }), { jar }));
    expect(cb.searchParams.get('code')).toBeTruthy();
    const admin = await owner();
    await rpc().setUserBan({ userId, actorId: admin.userId, ban: { reason: 'spam', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    const ex = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId(P, ENV), redirect_uri: `https://${P}.example.test/callback`, code: cb.searchParams.get('code')!, code_verifier: 'x'.repeat(43) }).toString(),
    });
    expect(ex.status).toBe(400);

    // Ban already over: sign-in works even before the cron clears the flag.
    await env.DB.prepare('UPDATE "user" SET banExpires = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), userId).run();
    await signIn(new CookieJar(), email);
  });

  it('refuses team members, unknown users and invalid expiry', async () => {
    const admin = await owner();
    const other = await owner();
    await expect(rpc().setUserBan({ userId: other.userId, actorId: admin.userId, ban: { reason: 'x', expiresAt: null } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(rpc().setUserBan({ userId: 'usr_missing', actorId: admin.userId, ban: { reason: 'x', expiresAt: null } })).rejects.toMatchObject({ code: 'not_found' });
    const { userId } = await signUp(new CookieJar());
    await expect(rpc().setUserBan({ userId, actorId: admin.userId, ban: { reason: 'x', expiresAt: new Date(Date.now() - 1).toISOString() } })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('emits user.banned / user.unbanned to the product environments the user signed in to, without the reason', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await ssoToProduct(jar, P, ENV);
    await seedEndpoint(P, ENV, ['user.banned', 'user.unbanned']);
    const admin = await owner();
    await rpc().setUserBan({ userId, actorId: admin.userId, ban: { reason: 'secret note', expiresAt: null } });
    const ev = await waitFor(() => received.find((e) => e.type === 'user.banned' && e.data.user_id === userId));
    expect(ev).toMatchObject({ product_id: P, env: ENV, data: { user_id: userId, expires_at: null } });
    expect(JSON.stringify(ev)).not.toContain('secret note');
    await rpc().setUserBan({ userId, actorId: admin.userId, ban: null });
    await waitFor(() => received.find((e) => e.type === 'user.unbanned' && e.data.user_id === userId && e.data.reason === 'admin'));
  });
});

describe('webhook events from sign-in (PRD §21.6)', () => {
  it('user.joined once per product environment, on the first authorization there', async () => {
    await seedEndpoint(P, 'dev', ['user.joined']);
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    await ssoToProduct(jar, P, 'dev');
    const ev = await waitFor(() => received.find((e) => e.type === 'user.joined' && e.data.user_id === userId));
    expect(ev).toMatchObject({ product_id: P, env: 'dev', data: { user_id: userId, anonymous: false } });
    await ssoToProduct(jar, P, 'dev');
    const { results } = await env.DB.prepare(`SELECT id FROM webhook_messages WHERE event_type = 'user.joined' AND payload LIKE ?`).bind(`%${userId}%`).all();
    expect(results).toHaveLength(1);
    expect(await env.DB.prepare('SELECT 1 AS x FROM product_env_users WHERE product_env_id = ? AND user_id = ?').bind(clientId(P, 'dev'), userId).first()).toBeTruthy();
  });

  it('user.upgraded when a guest links its first credential', async () => {
    await seedEndpoint(P, ENV, ['user.upgraded']);
    const jar = new CookieJar();
    const anon = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
    const guestId = (await anon.json<{ user: { id: string } }>()).user.id;
    await ssoToProduct(jar, P, ENV);
    const link = await call('/link/email', { jar, json: { email: uniqueEmail('guest'), password: PASSWORD } });
    expect(link.status).toBe(200);
    const ev = await waitFor(() => received.find((e) => e.type === 'user.upgraded' && e.data.user_id === guestId));
    expect(ev.data).toEqual({ user_id: guestId, provider: 'credential' });
  });
});

describe('impersonation (PRD §21.5.2)', () => {
  async function start(admin: Awaited<ReturnType<typeof owner>>, targetId: string) {
    const id = await requestImpersonation(admin.userId, targetId);
    const res = await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } });
    return { id, res };
  }

  it('the owner confirms with a TOTP code; products get tokens with act = owner; stop restores the owner and kills those tokens', async () => {
    const admin = await owner();
    const userJar = new CookieJar();
    const { userId } = await signUp(userJar);
    const id = await requestImpersonation(admin.userId, userId);

    const confirm = await call(`/impersonation/${id}`, { jar: admin.jar });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('ticket #42');
    expect((await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: '000000' } })).status).toBe(401);
    const started = await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } });
    expect(started.status).toBe(302);
    const s = await sessionOf(admin.jar);
    expect(s?.user.id).toBe(userId);
    expect(s?.session.impersonatedBy).toBe(admin.userId);

    const page = await (await call('/account', { jar: admin.jar })).text();
    expect(page).toContain('data-impersonation-banner');
    expect(page).toContain('End support session');

    const tokens = await ssoToProduct(admin.jar, P, ENV);
    expect(decodeJwt(tokens.access_token)).toMatchObject({ sub: userId, act: { sub: admin.userId } });
    expect(decodeJwt(tokens.id_token!)).toMatchObject({ sub: userId, act: { sub: admin.userId } });
    const refreshed = await refresh(P, ENV, tokens.refresh_token!);
    expect(refreshed.status).toBe(200);
    const rt = await refreshed.json<{ access_token: string; refresh_token: string }>();
    expect(decodeJwt(rt.access_token)).toMatchObject({ act: { sub: admin.userId } });

    expect((await auditRows('user.impersonation.start', userId))[0]).toMatchObject({ actor_id: admin.userId, metadata: { impersonation_id: id } });

    const stop = await call('/impersonation/stop', { jar: admin.jar, form: {} });
    expect(stop.status).toBe(302);
    expect((await sessionOf(admin.jar))?.user.id).toBe(admin.userId);
    expect((await refresh(P, ENV, rt.refresh_token)).status).toBe(400);
    expect((await auditRows('user.impersonation.stop', userId))[0]).toMatchObject({ metadata: { impersonation_id: id, end_reason: 'stopped' } });
    // The user's own tokens are not affected.
    expect((await ssoToProduct(userJar, P, ENV)).access_token).toBeTruthy();
    expect(decodeJwt((await ssoToProduct(admin.jar, P, ENV)).access_token).act).toBeUndefined();
  });

  it('cannot escalate: no console, no account-security changes, no data export or deletion, no sign-in, no nested impersonation', async () => {
    const admin = await owner();
    const { userId } = await signUp(new CookieJar());
    const { res } = await start(admin, userId);
    expect(res.status).toBe(302);
    const jar = admin.jar;

    const { challenge } = await pkcePair();
    const consoleAuth = await call(
      authorizeUrl({ productId: '', env: 'prod', state: randomToken(), nonce: randomToken(), challenge, client: CONSOLE, resource: CONSOLE_AUDIENCE }),
      { jar },
    );
    expect(consoleAuth.status === 400 || location(consoleAuth).searchParams.get('error') === 'access_denied').toBe(true);
    expect(consoleAuth.headers.get('location') ?? '').not.toContain('code=');

    for (const [path, body] of [
      ['/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another long password 1' }],
      ['/api/auth/change-email', { newEmail: uniqueEmail('x') }],
      ['/api/auth/unlink-account', { providerId: 'credential' }],
      ['/api/auth/revoke-other-sessions', {}],
      ['/api/auth/two-factor/enable', { password: PASSWORD }],
      ['/api/auth/delete-user', {}],
      ['/api/auth/link-social', { provider: 'google' }],
      ['/api/auth/revoke-sessions', {}],
      ['/api/auth/update-user', { name: 'x' }],
      ['/api/auth/sign-in/email', { email: admin.email, password: PASSWORD }],
    ] as const) {
      const r = await call(path, { jar, json: body });
      expect(r.status, path).toBe(403);
    }
    for (const path of ['/account/export', '/account/deletion', '/link/email']) {
      expect((await call(path, { jar, form: {} })).status, path).toBe(403);
    }
    const nested = await requestImpersonation(admin.userId, (await signUp(new CookieJar())).userId);
    expect((await call(`/impersonation/${nested}/start`, { jar, form: { code: await totp(admin.secret) } })).status).toBe(403);
    // Still impersonating; sign-out ends it.
    expect((await sessionOf(jar))?.session.impersonatedBy).toBe(admin.userId);
    await call('/api/auth/sign-out', { jar, json: {} });
    expect((await auditRows('user.impersonation.stop', userId))[0]?.metadata).toMatchObject({ end_reason: 'signed_out' });
  });

  it('expires after its lifetime: no further authorization or refresh, no act claim', async () => {
    const admin = await owner();
    const { userId } = await signUp(new CookieJar());
    const { id } = await start(admin, userId);
    const tokens = await ssoToProduct(admin.jar, P, ENV);
    await env.DB.prepare('UPDATE impersonations SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, id).run();
    expect((await refresh(P, ENV, tokens.refresh_token!)).status).toBe(400);
    const { challenge } = await pkcePair();
    const again = await call(authorizeUrl({ productId: P, env: ENV, state: randomToken(), nonce: randomToken(), challenge }), { jar: admin.jar });
    expect(again.headers.get('location') ?? '').not.toContain('code=');
  });

  it('only the requesting owner, with TOTP, for a non-team, non-banned user, within the request window', async () => {
    const admin = await owner();
    const other = await owner();
    const { userId } = await signUp(new CookieJar());

    // Someone else's request is invisible.
    const id = await requestImpersonation(other.userId, userId);
    expect((await call(`/impersonation/${id}`, { jar: admin.jar })).status).toBe(404);
    expect((await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(404);

    // A team member target, or a former owner, is refused at start.
    const member = await requestImpersonation(admin.userId, other.userId);
    expect((await call(`/impersonation/${member}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(403);
    const ownerless = await requestImpersonation(admin.userId, userId);
    await env.DB.prepare('DELETE FROM team_members WHERE user_id = ?').bind(admin.userId).run();
    expect((await call(`/impersonation/${ownerless}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(403);
    await env.DB.prepare(`INSERT INTO team_members (id, user_id, role, product_id, created_by, created_at) VALUES (?, ?, 'owner', NULL, 'test', ?)`)
      .bind(newId('tm'), admin.userId, Date.now()).run();

    // Banned target.
    const banned = await signUp(new CookieJar());
    const req = await requestImpersonation(admin.userId, banned.userId);
    await env.DB.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').bind(banned.userId).run();
    expect((await call(`/impersonation/${req}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(403);

    // Expired request.
    const late = await requestImpersonation(admin.userId, userId);
    await env.DB.prepare('UPDATE impersonations SET request_expires_at = ? WHERE id = ?').bind(Date.now() - 1, late).run();
    expect((await call(`/impersonation/${late}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(404);

    // An owner without TOTP sees the setup hint and cannot start.
    const plain = new CookieJar();
    const p = await signUp(plain);
    await env.DB.prepare(`INSERT INTO team_members (id, user_id, role, product_id, created_by, created_at) VALUES (?, ?, 'owner', NULL, 'test', ?)`)
      .bind(newId('tm'), p.userId, Date.now()).run();
    const noMfa = await requestImpersonation(p.userId, userId);
    expect(await (await call(`/impersonation/${noMfa}`, { jar: plain })).text()).toContain('/two-factor/setup');
    expect((await call(`/impersonation/${noMfa}/start`, { jar: plain, form: { code: '123456' } })).status).toBe(401);
  });

  it('wrong confirmation codes: the request is cancelled after 5 (audited); the start form is rate limited per IP', async () => {
    const admin = await owner();
    const { userId } = await signUp(new CookieJar());
    const id = await requestImpersonation(admin.userId, userId);
    for (let i = 0; i < 5; i++) {
      expect((await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: '000000' } })).status, `attempt ${i + 1}`).toBe(401);
    }
    // Cancelled: even the right code no longer starts it.
    expect((await call(`/impersonation/${id}/start`, { jar: admin.jar, form: { code: await totp(admin.secret) } })).status).toBe(404);
    expect(await env.DB.prepare('SELECT status, end_reason FROM impersonations WHERE id = ?').bind(id).first())
      .toEqual({ status: 'cancelled', end_reason: 'too_many_attempts' });
    expect((await auditRows('user.impersonation.cancel', userId))[0]).toMatchObject({
      actor_id: admin.userId, metadata: { impersonation_id: id, reason: 'too_many_attempts' },
    });

    // Per-IP limit of the auth endpoints (PRD §19.6) on the confirmation form.
    const other = await requestImpersonation(admin.userId, userId);
    const headers = { 'cf-connecting-ip': `203.0.113.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID().slice(0, 4)}` };
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_RATE_PER_IP_PER_MIN + 1; i++) {
      statuses.push((await call(`/impersonation/${other}/start`, { jar: admin.jar, headers, form: { code: 'x' } })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it('banning the target ends a running impersonation and its tokens', async () => {
    const admin = await owner();
    const { userId } = await signUp(new CookieJar());
    await start(admin, userId);
    const tokens = await ssoToProduct(admin.jar, P, ENV);
    const other = await owner();
    await rpc().setUserBan({ userId, actorId: other.userId, ban: { reason: 'abuse', expiresAt: null } });
    expect((await refresh(P, ENV, tokens.refresh_token!)).status).toBe(400);
    expect((await auditRows('user.impersonation.stop', userId))[0]?.metadata).toMatchObject({ end_reason: 'target_banned' });
    expect(await sessionOf(admin.jar)).toBeNull();
  });
});

await seedProduct(P);
