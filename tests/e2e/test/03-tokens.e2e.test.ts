// PRD §15 item 8 (+ §19.4 product disable): refresh-token rotation and reuse detection with its
// audit row, revocation (SDK sign-out), session invalidation by password reset, auth rate limits,
// and product disable taking effect on the API, on /authorize and on refresh.
import { beforeAll, describe, expect, it } from 'vitest';
import { Browser, TURNSTILE_DUMMY_TOKEN } from '../src/browser.ts';
import {
  PASSWORD, admin, api, authorizeCode, pkce, createProduct, createWebApp, errorOf, newUser, outbox, ownerToken as ownerConsoleToken, poll, stack,
  tokenRequest, uniqueProductId, type ProductEnv, type TokenSet,
} from '../src/world.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  a = await createProduct(ownerToken, uniqueProductId('ta'));
});

const productLogin = (browser: Browser, p: ProductEnv, login?: { email: string; password: string }) =>
  authorizeCode(browser, { clientId: p.clientId, redirectUri: p.redirectUri, resource: `urn:platform:${p.clientId}`, ...(login ? { login } : {}) });

const refresh = (p: ProductEnv, refreshToken: string) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: p.clientId });

describe('§15-8 refresh rotation and reuse detection', () => {
  it('rotates on every use; replaying a rotated token revokes the client family and writes a security audit row', async () => {
    const u = await newUser('rotate');
    const { tokens } = await productLogin(u.browser, a.prod);
    const rt1 = tokens!.refresh_token!;

    const r2 = await refresh(a.prod, rt1);
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as TokenSet;
    expect(t2.refresh_token).toBeTruthy();
    expect(t2.refresh_token).not.toBe(rt1);
    expect((await api('/v1/me', { key: a.prod.publishableKey, token: t2.access_token })).status).toBe(200);

    const replay = await refresh(a.prod, rt1);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    // The still-current token of the same family is gone too.
    expect((await refresh(a.prod, t2.refresh_token!)).status).toBe(400);

    const audit = await admin<{ entries: Array<{ action: string; target_id: string; actor_type: string }> }>(ownerToken, 'GET', `/audit?product_id=${a.productId}`);
    expect(audit.body.entries).toContainEqual(expect.objectContaining({ action: 'auth.refresh_token_reuse', target_id: u.userId, actor_type: 'system' }));
    // The identity-domain session survives (SSO for other products is not broken).
    const again = await productLogin(u.browser, a.prod);
    expect(again.tokens?.access_token).toBeTruthy();
  });

  it('the Web SDK restores a session from a persisted refresh token and rotates it', async () => {
    const u = await newUser('restore');
    const app = createWebApp(u.browser, a.prod, { persistRefreshToken: true });
    await app.signIn();
    const key = `zcb.${a.prod.clientId}.refresh_token`;
    const stored = app.tab.sessionStorage.getItem(key)!;
    expect(stored).toBeTruthy();

    // A reloaded page: new SDK instance, same tab storage, no access token in memory.
    const reloaded = createWebApp(u.browser, a.prod, { persistRefreshToken: true, tab: app.tab });
    expect(await reloaded.sdk.auth.getUser()).toMatchObject({ user_id: u.userId });
    expect(app.tab.sessionStorage.getItem(key)).not.toBe(stored);

    // Sign-out revokes the refresh token at the issuer.
    const current = app.tab.sessionStorage.getItem(key)!;
    reloaded.tab.activate();
    await reloaded.sdk.auth.signOut();
    expect(app.tab.sessionStorage.getItem(key)).toBeNull();
    expect((await refresh(a.prod, current)).status).toBe(400);
  });
});

describe('§15-6 callback replay and PKCE', () => {
  it('a replayed authorization code and a wrong code_verifier are refused with invalid_grant', async () => {
    const u = await newUser('replay');
    const { verifier, challenge } = pkce();
    const url = new URL(`${stack().issuer}/api/auth/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: a.prod.clientId, redirect_uri: a.prod.redirectUri, scope: 'openid offline_access', state: 's1',
      nonce: 'n1', code_challenge: challenge, code_challenge_method: 'S256', resource: `urn:platform:${a.prod.clientId}`,
    }).toString();
    const callback = await u.browser.authorize(url.toString());
    const code = callback.searchParams.get('code')!;
    const exchange = (v: string) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: a.prod.redirectUri, client_id: a.prod.clientId, code_verifier: v });
    expect((await exchange(verifier)).status).toBe(200);
    const replay = await exchange(verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');

    // A fresh code with the wrong verifier is refused (and burnt: the right verifier fails afterwards).
    const second = await u.browser.authorize(url.toString());
    const code2 = second.searchParams.get('code')!;
    const wrong = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: a.prod.redirectUri, client_id: a.prod.clientId, code_verifier: pkce().verifier });
    expect(wrong.ok).toBe(false);
    const late = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: a.prod.redirectUri, client_id: a.prod.clientId, code_verifier: verifier });
    expect(late.ok).toBe(false);
  });
});

describe('§15-8 password reset invalidates sessions and product refresh tokens', () => {
  it('after a reset, the old identity session and the old product refresh token are dead', async () => {
    const u = await newUser('reset');
    const { tokens } = await productLogin(u.browser, a.prod);
    const other = new Browser(stack().issuer);
    await other.request(`${stack().issuer}/forgot-password`, { form: { email: u.email } });
    const mail = await poll('reset mail', async () => (await outbox(u.email)).find((m) => m.template === 'reset_password'));
    const token = new URL((await other.request(mail.payload.url!)).headers.get('location')!, stack().issuer).searchParams.get('token')!;
    expect((await other.request(`${stack().issuer}/reset-password`, { form: { token, password: 'reset passphrase 2' } })).status).toBe(200);

    expect((await refresh(a.prod, tokens!.refresh_token!)).status).toBe(400);
    const s = await u.browser.request(`${stack().issuer}/api/auth/get-session`);
    expect(await s.json()).toBeNull();
  });
});

describe('§19.6 auth rate limits (D1 counters)', () => {
  it('answers 429 rate_limited with Retry-After after 10 sign-in attempts per IP per minute', async () => {
    const browser = new Browser(stack().issuer);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // The failures also trigger Turnstile after 3 (next test); the attempts carry the local test token.
      const res = await browser.request(`${stack().issuer}/api/auth/sign-in/email`, {
        json: { email: `nobody-${i}@example.test`, password: PASSWORD }, headers: { 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN },
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect((await errorOf(res)).code).toBe('rate_limited');
        expect(res.headers.get('retry-after')).toBeTruthy();
      }
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('§19.6 / §19.11 Turnstile after repeated sign-in failures (local verifier: testing dummy token)', () => {
  const issuer = () => stack().issuer;
  const reasonOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: { reason?: string } } }).error;

  it('after 3 failed sign-ins from a device its login form shows the widget and needs the token; solved, the SDK sign-in completes', async () => {
    const u = await newUser('turnstile');
    const device = new Browser(issuer());
    for (let i = 0; i < 3; i++) {
      const res = await device.request(`${issuer()}/login`, { form: { email: `nobody-${i}-${Date.now()}@example.test`, password: 'wrong password' } });
      expect(res.status).toBe(401);
    }
    const page = await (await device.request(`${issuer()}/login`)).text();
    expect(page).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(page).toContain('class="cf-turnstile"');

    // Without the widget's token: refused, even with the right password (form and JSON alike).
    const blocked = await device.request(`${issuer()}/login`, { form: { email: u.email, password: PASSWORD } });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain('class="cf-turnstile"');
    const json = await device.request(`${issuer()}/api/auth/sign-in/email`, { json: { email: `someone-${Date.now()}@example.test`, password: PASSWORD } });
    expect(json.status).toBe(403);
    expect(await reasonOf(json)).toMatchObject({ code: 'forbidden', details: { reason: 'turnstile_required' } });

    // The browser "solves" the challenge (Browser.authorize sends the dummy token when the widget is shown).
    const app = createWebApp(device, a.prod);
    await app.signIn(u.login);
    expect(await app.sdk.auth.getAccessToken()).toBeTruthy();
    // Another device is not challenged.
    expect(await (await new Browser(issuer()).request(`${issuer()}/login`)).text()).not.toContain('cf-turnstile');
  });

  it('an account that failed 3 times is challenged on every device', async () => {
    const email = `target-${Date.now()}@example.test`;
    for (let i = 0; i < 3; i++) {
      expect((await new Browser(issuer()).request(`${issuer()}/api/auth/sign-in/email`, { json: { email, password: `guess ${i}` } })).status).toBe(401);
    }
    const res = await new Browser(issuer()).request(`${issuer()}/api/auth/sign-in/email`, { json: { email, password: 'guess' } });
    expect(res.status).toBe(403);
    expect((await reasonOf(res)).details?.reason).toBe('turnstile_required');
  });
});

describe('§19.4 product disable', () => {
  it('blocks the API at once, refuses new authorizations and refreshes, and recovers when re-enabled', async () => {
    const p = await createProduct(ownerToken, uniqueProductId('td'));
    const u = await newUser('disable');
    const { tokens } = await productLogin(u.browser, p.prod);
    expect((await api('/v1/me', { key: p.prod.publishableKey, token: tokens!.access_token })).status).toBe(200);

    expect((await admin(ownerToken, 'PATCH', `/products/${p.productId}`, { status: 'disabled' })).status).toBe(200);

    const blocked = await api('/v1/me', { key: p.prod.publishableKey, token: tokens!.access_token });
    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).code).toBe('product_disabled');
    const refused = await refresh(p.prod, tokens!.refresh_token!);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_grant');
    const denied = await productLogin(u.browser, p.prod);
    expect(denied.callback.searchParams.get('error')).toBe('access_denied');
    expect(denied.tokens).toBeUndefined();

    expect((await admin(ownerToken, 'PATCH', `/products/${p.productId}`, { status: 'active' })).status).toBe(200);
    expect((await productLogin(u.browser, p.prod)).tokens?.access_token).toBeTruthy();
  });
});
