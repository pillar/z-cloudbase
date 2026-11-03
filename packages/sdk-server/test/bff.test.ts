import { describe, expect, it } from 'vitest';
import { createServerClient } from '../src/index.ts';
import { CALLBACK, CLIENT_ID, SECRET, baseConfig, createFakeIdp, fakeFetch } from './helpers.ts';

async function setup(opts: { authMethods?: string[]; secureCookies?: boolean } = {}) {
  const idp = await createFakeIdp(opts.authMethods ? { authMethods: opts.authMethods } : {});
  const api = fakeFetch(idp.handler);
  const server = createServerClient(baseConfig({ fetch: api.fetch }));
  const bff = server.bff({
    productId: 'product_a', env: 'dev', clientSecret: SECRET, redirectUri: CALLBACK,
    ...(opts.secureCookies === false ? { secureCookies: false } : {}),
  });
  return { idp, api, bff };
}

/** `name=value` pairs of Set-Cookie strings, the way a browser would send them back. */
const cookieHeader = (setCookies: string[]) =>
  setCookies.filter((c) => !/Max-Age=0\b/.test(c)).map((c) => c.split(';')[0]).join('; ');
const attrs = (c: string) => c.split(';').slice(1).map((s) => s.trim());
const byName = (cookies: string[], kind: string) => cookies.find((c) => c.startsWith(`cb_product_a_dev_${kind}=`))!;

async function login(s: Awaited<ReturnType<typeof setup>>) {
  const start = await s.bff.startLogin();
  const callback = s.idp.authorize(start.url);
  const session = await s.bff.handleCallback(callback, cookieHeader(start.cookies));
  return { start, callback, session };
}

describe('bff.startLogin', () => {
  it('builds a PKCE S256 authorization URL with the product resource and keeps secrets in an HttpOnly cookie', async () => {
    const { bff } = await setup();
    const { url, cookies } = await bff.startLogin();
    const p = new URL(url).searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('resource')).toBe('urn:platform:product_a.dev');
    expect(p.get('redirect_uri')).toBe(CALLBACK);
    expect(url).not.toContain(SECRET);

    expect(cookies).toHaveLength(1);
    expect(attrs(cookies[0]!)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']));
    expect(cookies[0]).not.toContain(SECRET);
  });
});

describe('bff.handleCallback', () => {
  it('exchanges the code with the client secret and returns HttpOnly/Secure/SameSite=Lax cookies', async () => {
    const s = await setup();
    const { session } = await login(s);

    const call = s.idp.tokenCalls[0]!;
    expect(call.headers.get('authorization')).toMatch(/^Basic /);
    expect(call.form().get('client_secret')).toBeNull(); // sent in the header, not the body
    expect(call.form().get('code_verifier')).toBeTruthy();
    expect(call.form().get('redirect_uri')).toBe(CALLBACK);

    expect(session.userId).toBe('usr_test');
    expect(session.accessToken).toMatch(/^eyJ/);
    expect(session.expiresIn).toBe(900);
    const rt = byName(session.cookies, 'rt');
    const at = byName(session.cookies, 'at');
    for (const c of [rt, at]) expect(attrs(c)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']));
    expect(attrs(rt)).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(attrs(at)).toContain('Max-Age=900');
    // login transaction cookie is consumed
    expect(attrs(byName(session.cookies, 'tx'))).toContain('Max-Age=0');
    expect(session.cookies.join(' ')).not.toContain(SECRET);
  });

  it('rejects a callback with a different state, without calling the token endpoint', async () => {
    const s = await setup();
    const start = await s.bff.startLogin();
    const cb = new URL(s.idp.authorize(start.url));
    cb.searchParams.set('state', 'forged');
    await expect(s.bff.handleCallback(cb.toString(), cookieHeader(start.cookies))).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(s.idp.tokenCalls).toHaveLength(0);
  });

  it('rejects a callback without the login cookie (login CSRF / replay in another browser)', async () => {
    const s = await setup();
    const start = await s.bff.startLogin();
    const cb = s.idp.authorize(start.url);
    await expect(s.bff.handleCallback(cb, null)).rejects.toMatchObject({ code: 'sdk_error' });
    await expect(s.bff.handleCallback(cb, 'cb_product_a_dev_tx=%7Bbroken')).rejects.toMatchObject({ code: 'sdk_error' });
    expect(s.idp.tokenCalls).toHaveLength(0);
  });

  it('rejects an id_token with the wrong nonce', async () => {
    const s = await setup();
    s.idp.nonceOverride = 'attacker-nonce';
    const start = await s.bff.startLogin();
    await expect(s.bff.handleCallback(s.idp.authorize(start.url), cookieHeader(start.cookies)))
      .rejects.toMatchObject({ code: 'nonce_mismatch' });
  });

  it('rejects a callback paired with the login cookie of another attempt', async () => {
    const s = await setup();
    const first = await s.bff.startLogin();
    const second = await s.bff.startLogin();
    await expect(s.bff.handleCallback(s.idp.authorize(second.url), cookieHeader(first.cookies)))
      .rejects.toMatchObject({ code: 'state_mismatch' });
  });

  it('surfaces an invalid client secret as an OAuth error', async () => {
    const idp = await createFakeIdp();
    const api = fakeFetch(idp.handler);
    const bff = createServerClient(baseConfig({ fetch: api.fetch })).bff({
      productId: 'product_a', env: 'dev', clientSecret: 'wrong', redirectUri: CALLBACK,
    });
    const start = await bff.startLogin();
    await expect(bff.handleCallback(idp.authorize(start.url), cookieHeader(start.cookies)))
      .rejects.toMatchObject({ code: 'invalid_client', status: 401, retryable: false });
  });

  it('omits Secure only when explicitly disabled for local http', async () => {
    const s = await setup({ secureCookies: false });
    const { session } = await login(s);
    expect(attrs(byName(session.cookies, 'rt'))).not.toContain('Secure');
    expect(attrs(byName(session.cookies, 'rt'))).toContain('HttpOnly');
  });

  it('uses client_secret_post when the issuer does not offer HTTP Basic', async () => {
    const s = await setup({ authMethods: ['client_secret_post'] });
    await login(s);
    const call = s.idp.tokenCalls[0]!;
    expect(call.headers.get('authorization')).toBeNull();
    expect(call.form().get('client_secret')).toBe(SECRET);
  });
});

describe('bff.refresh', () => {
  it('rotates the refresh token: sends the cookie value, returns a new one', async () => {
    const s = await setup();
    const { session } = await login(s);
    const oldRt = byName(session.cookies, 'rt');

    const next = await s.bff.refresh(cookieHeader(session.cookies));

    const sent = s.idp.tokenCalls.at(-1)!.form();
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(`cb_product_a_dev_rt=${sent.get('refresh_token')}`).toBe(oldRt.split(';')[0]);
    const newRt = byName(next.cookies, 'rt');
    expect(newRt.split(';')[0]).not.toBe(oldRt.split(';')[0]);
    expect(attrs(newRt)).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax']));
    expect(next.accessToken).toMatch(/^eyJ/);
  });

  it('fails with invalid_grant when an already-rotated token is replayed', async () => {
    const s = await setup();
    const { session } = await login(s);
    const header = cookieHeader(session.cookies);
    await s.bff.refresh(header);
    await expect(s.bff.refresh(header)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('fails with invalid_grant, and no request, when there is no refresh cookie', async () => {
    const s = await setup();
    await expect(s.bff.refresh(null)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(s.idp.tokenCalls).toHaveLength(0);
  });
});

describe('bff.signOut', () => {
  it('revokes the refresh token and clears every session cookie', async () => {
    const s = await setup();
    const { session } = await login(s);
    const rtValue = decodeURIComponent(byName(session.cookies, 'rt').split(';')[0]!.split('=')[1]!);

    const { cookies } = await s.bff.signOut(cookieHeader(session.cookies));

    expect(s.idp.revoked).toEqual([rtValue]);
    expect(cookies).toHaveLength(3);
    for (const c of cookies) expect(attrs(c)).toContain('Max-Age=0');
  });

  it('still clears cookies when revocation fails', async () => {
    const s = await setup();
    const { session } = await login(s);
    s.idp.failRevoke = true;
    const { cookies } = await s.bff.signOut(cookieHeader(session.cookies));
    expect(cookies.every((c) => attrs(c).includes('Max-Age=0'))).toBe(true);
  });
});
