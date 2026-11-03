// Turnstile after repeated authentication failures (PRD §19.6, §19.11): per account and per IP,
// within AUTH_FAILURE_WINDOW_S; sign-in, sign-up, password reset and /link/email then need a valid
// token. Local verification accepts only Cloudflare's testing dummy token and never uses the
// network; the siteverify adapter is exercised with an injected fetch (production remote-unverified).
import { AUTH_FAILURE_WINDOW_S, TURNSTILE_AFTER_FAILURES } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { SITEVERIFY_URL, TURNSTILE_DUMMY_TOKEN, localVerifier, siteverifyVerifier } from '../src/turnstile.ts';
import { CookieJar, PASSWORD, auth, call, uniqueEmail, useEnv } from './helpers.ts';

const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID().slice(0, 8)}`;
const solved = { 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN };

const signInJson = (email: string, password: string, headers: Record<string, string> = {}) =>
  call('/api/auth/sign-in/email', { headers, json: { email, password } });

async function expectChallenge(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json<{ error: { code: string; request_id: string; details: { reason: string; site_key: string } } }>();
  expect(body.error).toMatchObject({ code: 'forbidden', details: { reason: 'turnstile_required', site_key: env.TURNSTILE_SITE_KEY } });
  expect(body.error.request_id).toMatch(/^req_/);
}

/** A registered Email/Password user, created without HTTP (no rate-limit budget spent). */
async function createUser() {
  const email = uniqueEmail('ts');
  await auth().api.signUpEmail({ body: { email, password: PASSWORD, name: '' } });
  return email;
}

/** TURNSTILE_AFTER_FAILURES wrong-password sign-ins for `email`, each from a different IP. */
async function failAccount(email: string) {
  for (let i = 0; i < TURNSTILE_AFTER_FAILURES; i++) {
    expect((await signInJson(email, `wrong ${i}`, { 'cf-connecting-ip': ip() })).status).toBe(401);
  }
}

/** TURNSTILE_AFTER_FAILURES failed sign-ins from `addr`, each for a different (unknown) account. */
async function failIp(addr: string) {
  for (let i = 0; i < TURNSTILE_AFTER_FAILURES; i++) {
    expect((await signInJson(uniqueEmail('nobody'), 'wrong', { 'cf-connecting-ip': addr })).status).toBe(401);
  }
}

// Every attempt below also passes the per-account rate limit (5 / minute, test/rate-limit.test.ts),
// so each test spends at most 5 HTTP attempts per account and users are created server-side.
describe('Turnstile per account', () => {
  it('is not required below the threshold', async () => {
    const email = await createUser();
    for (let i = 0; i < TURNSTILE_AFTER_FAILURES - 1; i++) expect((await signInJson(email, 'wrong', { 'cf-connecting-ip': ip() })).status).toBe(401);
    expect((await signInJson(email, PASSWORD, { 'cf-connecting-ip': ip() })).status).toBe(200);
  });

  it(`is required after ${TURNSTILE_AFTER_FAILURES} failed sign-ins from different IPs; a missing or forged token is refused`, async () => {
    const email = await createUser();
    await failAccount(email);
    await expectChallenge(await signInJson(email, PASSWORD, { 'cf-connecting-ip': ip() }));
    await expectChallenge(await signInJson(email, PASSWORD, { 'cf-connecting-ip': ip(), 'cf-turnstile-response': 'forged-token' }));
    // Another account is unaffected.
    expect((await signInJson(await createUser(), PASSWORD)).status).toBe(200);
  });

  it('other spellings of the account and a trailing slash on the endpoint do not get around it', async () => {
    const email = await createUser();
    await failAccount(email);
    await expectChallenge(await signInJson(`  ${email.toUpperCase()} `, PASSWORD, { 'cf-connecting-ip': ip() }));
    await expectChallenge(await call('/api/auth/sign-in/email/', { headers: { 'cf-connecting-ip': ip() }, json: { email, password: PASSWORD } }));
  });

  it('a token in the JSON body is not read; requesting a password reset for the account is challenged too', async () => {
    const email = await createUser();
    await failAccount(email);
    await expectChallenge(await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD, 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN } }));
    await expectChallenge(await call('/api/auth/request-password-reset', { json: { email, redirectTo: '/reset-password' } }));
  });

  it('a successful sign-in (with the token) clears the account counter', async () => {
    const email = await createUser();
    await failAccount(email);
    expect((await signInJson(email, PASSWORD, solved)).status).toBe(200);
    expect((await signInJson(email, PASSWORD)).status).toBe(200);
  });

  it('failures older than the window no longer count', async () => {
    const email = await createUser();
    await failAccount(email);
    await env.DB.prepare('UPDATE auth_failures SET occurred_at = occurred_at - ?').bind((AUTH_FAILURE_WINDOW_S + 1) * 1000).run();
    expect((await signInJson(email, PASSWORD)).status).toBe(200);
  });
});

describe('Turnstile per IP', () => {
  it('is required for every guarded endpoint from that IP once it failed, but not for other IPs', async () => {
    const addr = ip();
    await failIp(addr);
    const headers = { 'cf-connecting-ip': addr };
    await expectChallenge(await call('/api/auth/sign-up/email', { headers, json: { email: uniqueEmail(), password: PASSWORD, name: '' } }));
    await expectChallenge(await call('/api/auth/request-password-reset', { headers, json: { email: uniqueEmail(), redirectTo: '/reset-password' } }));
    await expectChallenge(await call('/api/auth/reset-password', { headers, json: { token: 'x', newPassword: PASSWORD } }));
    await expectChallenge(await call('/link/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } }));
    await expectChallenge(await signInJson(uniqueEmail(), PASSWORD, headers));

    // With the token the request reaches the engine.
    expect((await call('/api/auth/sign-up/email', { headers: { ...headers, ...solved }, json: { email: uniqueEmail(), password: PASSWORD, name: '' } })).status).toBe(200);
    // Another IP, fresh accounts: no challenge.
    expect((await call('/api/auth/sign-up/email', { json: { email: uniqueEmail(), password: PASSWORD, name: '' } })).status).toBe(200);
  });

  it('a successful sign-in from the IP does not clear the IP counter', async () => {
    const email = await createUser();
    const addr = ip();
    await failIp(addr);
    expect((await signInJson(email, PASSWORD, { 'cf-connecting-ip': addr, ...solved })).status).toBe(200);
    await expectChallenge(await signInJson(email, PASSWORD, { 'cf-connecting-ip': addr }));
  });

  it('invalid password-reset tokens count as failures of the IP', async () => {
    const addr = ip();
    for (let i = 0; i < TURNSTILE_AFTER_FAILURES; i++) {
      expect((await call('/api/auth/reset-password', { headers: { 'cf-connecting-ip': addr }, json: { token: `guess-${i}`, newPassword: PASSWORD } })).status).toBe(400);
    }
    await expectChallenge(await signInJson(uniqueEmail(), PASSWORD, { 'cf-connecting-ip': addr }));
  });

  it('stores only HMACs of the account and IP', async () => {
    const email = uniqueEmail('stored');
    const addr = ip();
    expect((await signInJson(email, 'wrong', { 'cf-connecting-ip': addr })).status).toBe(401);
    const { results } = await env.DB.prepare('SELECT subject FROM auth_failures ORDER BY id DESC LIMIT 2').all<{ subject: string }>();
    expect(results.map((r) => r.subject.split(':')[0]).sort()).toEqual(['acct', 'ip']);
    for (const r of results) {
      expect(r.subject).toMatch(/^(acct|ip):[0-9a-f]{64}$/);
      expect(r.subject).not.toContain(email);
      expect(r.subject).not.toContain(addr);
    }
  });
});

describe('Turnstile on the identity pages', () => {
  const unescape = (s: string) => s.replace(/&amp;/g, '&');

  it('the login form counts failures with the JSON endpoint, then shows the widget and needs its token', async () => {
    const email = await createUser();
    const addr = ip();
    const headers = { 'cf-connecting-ip': addr };
    expect(await (await call('/login', { headers })).text()).not.toContain('cf-turnstile');

    // Failures through the form and through JSON add up (same account, case-insensitive).
    expect((await call('/login', { headers, form: { email: email.toUpperCase(), password: 'wrong' } })).status).toBe(401);
    expect((await signInJson(email, 'wrong', headers)).status).toBe(401);
    const third = await call('/login', { headers, form: { email, password: 'wrong' } });
    expect(third.status).toBe(401);
    // The re-rendered form already carries the widget with the site key.
    const thirdPage = unescape(await third.text());
    expect(thirdPage).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(thirdPage).toContain(`data-sitekey="${env.TURNSTILE_SITE_KEY}"`);
    expect(await (await call('/login', { headers })).text()).toContain('class="cf-turnstile"');

    const jar = new CookieJar();
    const blocked = await call('/login', { jar, headers, form: { email, password: PASSWORD } });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain('class="cf-turnstile"');
    expect(jar.cookies.size).toBe(0);

    const ok = await call('/login', { jar, headers, form: { email, password: PASSWORD, 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/account');
  });

  it('register, forgot-password, reset and the anonymous upgrade forms are challenged from a failing IP', async () => {
    const addr = ip();
    await failIp(addr);
    const headers = { 'cf-connecting-ip': addr };
    for (const [path, form] of [
      ['/register', { email: uniqueEmail(), password: PASSWORD }],
      ['/forgot-password', { email: uniqueEmail() }],
      ['/reset-password', { token: 'x', password: PASSWORD }],
    ] as const) {
      expect(await (await call(path, { headers })).text()).toContain('class="cf-turnstile"');
      const res = await call(path, { headers, form });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('class="cf-turnstile"');
    }
    expect((await call('/register', { headers, form: { email: uniqueEmail(), password: PASSWORD, 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN } })).status).toBe(200);

    const guest = new CookieJar();
    expect((await call('/api/auth/sign-in/anonymous', { jar: guest, method: 'POST', json: {} })).status).toBe(200);
    const link = await call('/link/email', { jar: guest, headers, form: { email: uniqueEmail(), password: PASSWORD } });
    expect(link.status).toBe(403);
    expect(await link.text()).toContain('class="cf-turnstile"');
    const linked = await call('/link/email', { jar: guest, headers, form: { email: uniqueEmail(), password: PASSWORD, 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN } });
    expect(linked.status).toBe(302);
  });
});

describe('a deployment without TURNSTILE_SECRET_KEY', () => {
  afterEach(() => useEnv(null));

  it('never challenges: repeated failures only meet the rate limits', async () => {
    useEnv({ DEPLOY_ENV: 'prod' });
    const email = await createUser();
    await failAccount(email);
    expect((await signInJson(email, PASSWORD, { 'cf-connecting-ip': ip() })).status).toBe(200);
  });
});

describe('Turnstile verifiers', () => {
  it('local: only the testing dummy token passes', async () => {
    expect(await localVerifier.verify(TURNSTILE_DUMMY_TOKEN, '1.2.3.4')).toBe(true);
    for (const t of ['', 'XXXX.DUMMY.TOKEN', 'xxxx.dummy.token.xxxx', 'anything']) expect(await localVerifier.verify(t, '1.2.3.4')).toBe(false);
  });

  it('siteverify: posts secret, response and remote IP and trusts only success=true (injected fetch, no network)', async () => {
    const seen: Array<{ url: string; body: Record<string, string> }> = [];
    const answers = [{ success: true }, { success: false, 'error-codes': ['invalid-input-response'] }, { success: 'true' }];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: Object.fromEntries([...(init.body as FormData).entries()].map(([k, v]) => [k, String(v)])) });
      return Response.json(answers[seen.length - 1]);
    }) as unknown as typeof fetch;
    const v = siteverifyVerifier('secret-key', fakeFetch);
    expect(await v.verify('tok', '203.0.113.9')).toBe(true);
    expect(await v.verify('tok', '203.0.113.9')).toBe(false);
    expect(await v.verify('tok', '203.0.113.9')).toBe(false);
    expect(seen[0]).toEqual({ url: SITEVERIFY_URL, body: { secret: 'secret-key', response: 'tok', remoteip: '203.0.113.9' } });

    const down = siteverifyVerifier('secret-key', (async () => new Response('', { status: 502 })) as unknown as typeof fetch);
    await expect(down.verify('tok', '203.0.113.9')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
