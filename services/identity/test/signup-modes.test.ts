// Registration modes, email verification and invitations (PRD §21.2). Deployment vars are switched with
// `useEnv`; mail goes to the local outbox (DEPLOY_ENV=local), except where a test simulates a deployment
// without mail (DEPLOY_ENV=production, no EMAIL_FROM).
import { GOOGLE_ENDPOINTS, createMockOidcProvider, interceptFetch, type MockOidcProvider } from '@z-cloudbase/testing';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IdentityRpc } from '../src/index.ts';
import { createInvitation } from '../src/invitations.ts';
import { CookieJar, PASSWORD, auditRows, call, outbox, signUp, uniqueEmail, useEnv } from './helpers.ts';
import { authorizeUrl, pkcePair, randomToken, setupClients } from './oauth-flow.ts';

const ADMIN = 'usr_signup_mode_admin';
const varsEnv = (vars: Record<string, string>) => ({ ...env, ...vars }) as unknown as Env;
const userByEmail = (email: string) =>
  env.DB.prepare('SELECT id, emailVerified FROM "user" WHERE email = ?').bind(email).first<{ id: string; emailVerified: number }>();
const inviteToken = (url: string) => new URL(url).searchParams.get('invite')!;
const rpc = (e: Env = env) => new IdentityRpc(createExecutionContext(), e);

let google: MockOidcProvider;
beforeAll(async () => {
  await setupClients([{ productId: 'mode_game', env: 'prod' }]);
  google = await createMockOidcProvider(GOOGLE_ENDPOINTS);
  vi.spyOn(globalThis, 'fetch').mockImplementation(interceptFetch(globalThis.fetch.bind(globalThis), [google]));
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => useEnv(null));

/** Invitation mail (outbox) → link token. */
async function invite(email: string, vars: Record<string, string> = { SIGNUP_MODE: 'invite' }, days = 7) {
  const created = await createInvitation(varsEnv(vars), { email, expiresInDays: days, actorId: ADMIN });
  const mail = (await outbox(email)).find((m) => m.template === 'invitation');
  return { created, token: inviteToken(created.url ?? mail!.payload.url!) };
}

async function redeem(token: string, password = PASSWORD) {
  return call('/register', { form: { invite: token, password, oauth_query: '' } });
}

describe('SIGNUP_MODE=open (default)', () => {
  it('lets anyone register and offers registration on the sign-in page', async () => {
    const page = await (await call('/login')).text();
    expect(page).toContain('href="/register"');
    expect((await call('/api/auth/sign-up/email', { json: { email: uniqueEmail(), password: PASSWORD, name: '' } })).status).toBe(200);
  });
});

describe('SIGNUP_MODE=invite', () => {
  it('refuses open sign-up (JSON and form), guests and anonymous sign-in', async () => {
    useEnv({ SIGNUP_MODE: 'invite' });
    const email = uniqueEmail('closed');
    const json = await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: '' } });
    expect(json.status).toBe(403);
    expect(await json.json()).toMatchObject({ code: 'SIGNUP_CLOSED' });
    expect((await call('/register', { form: { email, password: PASSWORD } })).status).toBe(403);
    expect((await call('/register')).status).toBe(403);
    expect(await (await call('/login')).text()).not.toContain('href="/register');
    expect((await call('/api/auth/sign-in/anonymous', { json: {} })).status).toBe(403);
    const { challenge } = await pkcePair();
    const authorize = `${env.ISSUER}${authorizeUrl({ productId: 'mode_game', env: 'prod', state: randomToken(), nonce: randomToken(), challenge })}`;
    const guest = await call(`/guest?${new URLSearchParams({ authorize })}`);
    expect(guest.status).toBe(403);
    expect(await guest.json()).toMatchObject({ error: { code: 'forbidden', details: { reason: 'signup_closed' } } });
    expect(await userByEmail(email)).toBeNull();
  });

  it('does not create new Google users, but a linked Google account keeps signing in', async () => {
    // Linked while the platform was open.
    const jar = new CookieJar();
    const existing = await signUp(jar);
    const sub = `g-${crypto.randomUUID()}`;
    const linkStart = await call('/api/auth/link-social', { jar, json: { provider: 'google', callbackURL: `${env.ISSUER}/done`, disableRedirect: true } });
    const linked = await call(google.authorize((await linkStart.json<{ url: string }>()).url, { sub, email: uniqueEmail('g') }), { jar });
    expect(new URL(linked.headers.get('location')!, env.ISSUER).pathname).toBe('/done');

    useEnv({ SIGNUP_MODE: 'invite' });
    const signIn = async (who: { sub: string; email: string }) => {
      const j = new CookieJar();
      const start = await call('/api/auth/sign-in/social', { jar: j, json: { provider: 'google', callbackURL: `${env.ISSUER}/done`, errorCallbackURL: `${env.ISSUER}/error`, disableRedirect: true } });
      const cb = await call(google.authorize((await start.json<{ url: string }>()).url, who), { jar: j });
      return new URL(cb.headers.get('location')!, env.ISSUER);
    };
    const stranger = await signIn({ sub: `g-${crypto.randomUUID()}`, email: uniqueEmail('stranger') });
    expect(stranger.pathname).toBe('/error');
    expect((await signIn({ sub, email: uniqueEmail('g2') })).pathname).toBe('/done');
    expect(existing.userId).toMatch(/^usr_/);
  });

  it('an emailed invitation registers exactly one verified account for its address, once', async () => {
    const email = uniqueEmail('invited');
    const { created, token } = await invite(email);
    expect(created).toMatchObject({ email, status: 'pending', delivery: 'email' });
    expect(created.url).toBeUndefined(); // mailed only, never shown to the admin
    useEnv({ SIGNUP_MODE: 'invite' });

    const form = await call(`/register?invite=${encodeURIComponent(token)}`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain(email);
    const res = await redeem(token);
    expect(res.status).toBe(200);
    const user = await userByEmail(email);
    expect(user?.emailVerified).toBe(1); // the link went to this mailbox
    expect((await auditRows('auth.invitation_redeemed', created.id))[0]).toMatchObject({ actor_type: 'user', actor_id: user!.id });
    expect((await auditRows('invitation.create', created.id))[0]).toMatchObject({ actor_id: ADMIN });

    // Single use: the same link is now invalid (page and form post alike).
    expect((await call(`/register?invite=${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await redeem(token, 'another passphrase 2')).status).toBe(404);
    const rows = await env.DB.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?').bind(email).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it('the invited address is fixed: a form cannot register another email with the token', async () => {
    const email = uniqueEmail('fixed');
    const { token } = await invite(email);
    useEnv({ SIGNUP_MODE: 'invite' });
    const other = uniqueEmail('other');
    await call('/register', { form: { invite: token, email: other, password: PASSWORD } });
    expect(await userByEmail(other)).toBeNull();
    expect(await userByEmail(email)).not.toBeNull();
  });

  it('a failed registration releases the invitation; expired, revoked and unknown links are refused alike', async () => {
    const email = uniqueEmail('retry');
    const { token } = await invite(email);
    useEnv({ SIGNUP_MODE: 'invite' });
    expect((await redeem(token, 'short')).status).toBe(400); // engine: password too short
    expect((await redeem(token)).status).toBe(200);

    const expired = await invite(uniqueEmail('expired'));
    await env.DB.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, expired.created.id).run();
    const revoked = await invite(uniqueEmail('revoked'));
    expect(await rpc().revokeInvitation({ id: revoked.created.id, actorId: ADMIN })).toMatchObject({ ok: true, value: { status: 'revoked' } });
    for (const t of [expired.token, revoked.token, 'not-a-token']) {
      expect((await call(`/register?invite=${encodeURIComponent(t)}`)).status).toBe(404);
      expect((await redeem(t)).status).toBe(404);
    }
  });

  it('a JSON sign-up cannot use the invitation (it is redeemed only through the form)', async () => {
    const email = uniqueEmail('json');
    await invite(email);
    useEnv({ SIGNUP_MODE: 'invite' });
    expect((await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: '' } })).status).toBe(403);
  });
});

describe('SIGNUP_MODE=closed', () => {
  it('creates no accounts at all, not even with an invitation; existing users sign in', async () => {
    const existing = await signUp(new CookieJar());
    const email = uniqueEmail('closed-invite');
    const { token } = await invite(email, {});
    useEnv({ SIGNUP_MODE: 'closed' });
    expect((await redeem(token)).status).toBe(404);
    expect((await call('/api/auth/sign-up/email', { json: { email: uniqueEmail(), password: PASSWORD, name: '' } })).status).toBe(403);
    expect((await call('/api/auth/sign-in/email', { json: { email: existing.email, password: PASSWORD } })).status).toBe(200);
    expect(await userByEmail(email)).toBeNull();
  });

  it('operator setup is not affected by the registration mode', async () => {
    useEnv({ SIGNUP_MODE: 'closed' });
    const res = await call('/setup/install', {
      headers: { authorization: 'Bearer test-only-setup-token' },
      json: { admin_email: uniqueEmail('owner'), admin_password: 'a-long-admin-passphrase', console_redirect_uris: ['https://console.example.test/'] },
    });
    // 201 on an empty platform, 200 ("exists") once another test installed an owner: never refused.
    expect([200, 201]).toContain(res.status);
  });
});

describe('REQUIRE_EMAIL_VERIFICATION', () => {
  it('true: an unverified address cannot sign in with a password; the attempt mails a new link; verifying unlocks it', async () => {
    useEnv({ REQUIRE_EMAIL_VERIFICATION: 'true' });
    const email = uniqueEmail('verify-first');
    expect((await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: '' } })).status).toBe(200);
    const blocked = await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } });
    expect(blocked.status).toBe(403);
    const mails = (await outbox(email)).filter((m) => m.template === 'verify_email');
    expect(mails.length).toBe(2); // sign-up + the blocked sign-in
    const link = new URL(mails[0]!.payload.url!);
    expect((await call(`${link.pathname}${link.search}`)).status).toBe(302);
    expect((await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } })).status).toBe(200);
  });

  it('true without any mail transport: email sign-up, the anonymous upgrade and link invitations are unavailable', async () => {
    const noMail = { DEPLOY_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'true' };
    useEnv(noMail);
    expect((await call('/api/auth/sign-up/email', { json: { email: uniqueEmail(), password: PASSWORD, name: '' } })).status).toBe(403);
    expect((await call('/register')).status).toBe(403);
    const forgot = await (await call('/forgot-password')).text();
    expect(forgot).not.toContain('action="/forgot-password"');
    expect((await call('/link/email', { json: { email: uniqueEmail(), password: PASSWORD } })).status).toBe(403);
    expect(await rpc(varsEnv(noMail)).createInvitation({ email: uniqueEmail(), expiresInDays: 7, actorId: ADMIN })).toMatchObject({
      ok: false, error: { code: 'invalid_request' },
    });
  });

  it('false without mail (operator opt-in): sign-up works and a link invitation is returned once to the admin', async () => {
    const vars = { DEPLOY_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'false', SIGNUP_MODE: 'invite' };
    const email = uniqueEmail('link-invite');
    const r = await rpc(varsEnv(vars)).createInvitation({ email, expiresInDays: 3, actorId: ADMIN });
    expect(r.ok).toBe(true);
    const created = (r as { ok: true; value: { delivery: string; url?: string } }).value;
    expect(created.delivery).toBe('link');
    expect(created.url).toMatch(new RegExp(`^${env.ISSUER}/register\\?invite=`));
    useEnv(vars);
    expect((await redeem(inviteToken(created.url!))).status).toBe(200);
    expect((await userByEmail(email))?.emailVerified).toBe(0); // the link did not prove the mailbox
    expect((await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } })).status).toBe(200);
  });
});

describe('invitation management (IdentityRpc)', () => {
  it('refuses an address that already has an account or a pending invitation', async () => {
    const existing = await signUp(new CookieJar());
    expect(await rpc().createInvitation({ email: existing.email.toUpperCase(), expiresInDays: 7, actorId: ADMIN })).toMatchObject({
      ok: false, error: { code: 'conflict' },
    });
    const email = uniqueEmail('twice');
    expect((await rpc().createInvitation({ email, expiresInDays: 7, actorId: ADMIN })).ok).toBe(true);
    expect(await rpc().createInvitation({ email, expiresInDays: 7, actorId: ADMIN })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('lists by status, never exposes token hashes, mails in the requested language and audits revocation', async () => {
    const email = uniqueEmail('listed');
    const created = await rpc().createInvitation({ email, expiresInDays: 2, lang: 'zh', actorId: ADMIN, requestId: 'req_test' });
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; value: { id: string } }).value.id;
    expect((await outbox(email))[0]).toMatchObject({ template: 'invitation', payload: { lang: 'zh', days: '2' } });
    const pending = await rpc().listInvitations({ status: 'pending', limit: 200, offset: 0 });
    const row = pending.invitations.find((i) => i.id === id)!;
    expect(row).toMatchObject({ email, status: 'pending', created_by: ADMIN });
    expect(JSON.stringify(pending)).not.toContain('token');
    expect(await rpc().revokeInvitation({ id, actorId: ADMIN })).toMatchObject({ ok: true, value: { status: 'revoked' } });
    expect(await rpc().revokeInvitation({ id, actorId: ADMIN })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await rpc().revokeInvitation({ id: 'inv_00000000-0000-7000-8000-000000000000', actorId: ADMIN })).toMatchObject({
      ok: false, error: { code: 'not_found' },
    });
    expect((await rpc().listInvitations({ status: 'revoked', limit: 200, offset: 0 })).invitations.map((i) => i.id)).toContain(id);
    expect(await auditRows('invitation.revoke', id)).toHaveLength(1);
    expect((await auditRows('invitation.create', id))[0]!.metadata).toEqual({ delivery: 'email', expires_in_days: 2 });
  });

  it('validates its input', async () => {
    await expect(rpc().createInvitation({ email: 'not-an-email', expiresInDays: 7, actorId: ADMIN })).rejects.toThrow();
    await expect(rpc().createInvitation({ email: uniqueEmail(), expiresInDays: 31, actorId: ADMIN })).rejects.toThrow();
  });
});
