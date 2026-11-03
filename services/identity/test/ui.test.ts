// Server-rendered identity pages: form flows through the engine, escaping, same-origin form
// posts, and the user center that lists only the signed-in user's own memberships.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerProductClient } from '../src/clients.ts';
import { asSystem } from '../src/system.ts';
import { CookieJar, PASSWORD, auth, call, membership, outbox, seedProduct, signUp, uniqueEmail } from './helpers.ts';
import { REDIRECT, authorizeUrl, pkcePair, randomToken, setupClients, ssoToProduct } from './oauth-flow.ts';

const unescape = (s: string) => s.replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function hidden(htmlText: string, name: string) {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(htmlText);
  return m ? unescape(m[1]!) : null;
}

/** Start an authorization without a session: the engine sends the browser to /login. */
async function startAuthorize(jar: CookieJar, productId: string) {
  const { challenge } = await pkcePair();
  const res = await call(authorizeUrl({ productId, env: 'prod', state: randomToken(), nonce: randomToken(), challenge }), { jar });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!, env.ISSUER);
}

describe('identity pages', () => {
  beforeAll(async () => {
    await setupClients([
      { productId: 'product_a', env: 'prod' },
      { productId: 'product_b', env: 'prod' },
    ]);
  });

  it('login page escapes everything it echoes', async () => {
    const res = await call('/login?x=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    const text = await res.text();
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(text).not.toContain('<script>');
    expect(hidden(text, 'oauth_query')).toBe('x=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  });

  it('authorize -> login form -> back to the client with a code', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const jar = new CookieJar();
    const login = await startAuthorize(jar, 'product_a');
    expect(login.pathname).toBe('/login');
    const page = await (await call(`${login.pathname}${login.search}`, { jar })).text();
    const oauthQuery = hidden(page, 'oauth_query')!;

    const res = await call('/login', { jar, form: { email, password: PASSWORD, oauth_query: oauthQuery } });
    expect(res.status).toBe(302);
    const cb = new URL(res.headers.get('location')!);
    expect(`${cb.origin}${cb.pathname}`).toBe(REDIRECT('product_a'));
    expect(cb.searchParams.get('code')).toBeTruthy();
    // The identity session cookie reached the browser.
    const session = await (await call('/api/auth/get-session', { jar })).json<{ user: { id: string } }>();
    expect(session.user.id).toBe(userId);
  });

  it('a wrong password re-renders the form with an error and sets no session', async () => {
    const { email } = await signUp(new CookieJar());
    const jar = new CookieJar();
    const res = await call('/login', { jar, form: { email, password: 'wrong password!' } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('role="alert"');
    expect(jar.cookies.size).toBe(0);
  });

  it('form posts from another origin are refused', async () => {
    const { email } = await signUp(new CookieJar());
    const res = await call('/login', { headers: { origin: 'https://evil.example.test' }, form: { email, password: PASSWORD } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('register answers the same page for new and existing addresses', async () => {
    const existing = await signUp(new CookieJar());
    const fresh = await call('/register', { form: { email: uniqueEmail('ui'), password: PASSWORD } });
    const dup = await call('/register', { form: { email: existing.email, password: PASSWORD } });
    expect(fresh.status).toBe(200);
    expect(dup.status).toBe(200);
    const strip = (s: string) => s.replace(/req_[\w-]+/g, '');
    expect(strip(await dup.text())).toBe(strip(await fresh.text()));
  });

  it('forgot / reset password pages complete a reset', async () => {
    const { email } = await signUp(new CookieJar());
    const known = await (await call('/forgot-password', { form: { email } })).text();
    const unknown = await (await call('/forgot-password', { form: { email: uniqueEmail('nobody') } })).text();
    expect(known).toBe(unknown);

    const link = new URL((await outbox(email)).find((m) => m.template === 'reset_password')!.payload.url!);
    const landing = await call(`${link.pathname}${link.search}`);
    const resetPage = new URL(landing.headers.get('location')!, env.ISSUER);
    expect(resetPage.pathname).toBe('/reset-password');
    const form = await (await call(`${resetPage.pathname}${resetPage.search}`)).text();
    const token = hidden(form, 'token')!;
    const done = await call('/reset-password', { form: { token, password: 'fresh passphrase 2' } });
    expect(done.status).toBe(200);
    expect((await call('/api/auth/sign-in/email', { json: { email, password: 'fresh passphrase 2' } })).status).toBe(200);
  });

  it('user center lists only the signed-in user\'s own memberships, escaped', async () => {
    await seedProduct('product_a', { name: '<b>Alpha</b>' });
    const alice = new CookieJar();
    const a = await signUp(alice);
    await ssoToProduct(alice, 'product_a');
    const bob = new CookieJar();
    const b = await signUp(bob);
    await ssoToProduct(bob, 'product_b');
    expect(await membership(b.userId, 'product_b')).not.toBeNull();

    const page = await (await call('/account', { jar: alice })).text();
    expect(page).toContain('&lt;b&gt;Alpha&lt;/b&gt;');
    expect(page).not.toContain('<b>Alpha</b>');
    expect(page).not.toContain('product_b');
    expect(await membership(a.userId, 'product_b')).toBeNull();

    const anonymousVisitor = await call('/account');
    expect(anonymousVisitor.status).toBe(302);
    expect(anonymousVisitor.headers.get('location')).toBe('/login');
  });

  it('link page lets an anonymous user add Email/Password and keeps the user id', async () => {
    const jar = new CookieJar();
    const anon = await call('/api/auth/sign-in/anonymous', { jar, json: {} });
    const anonId = (await anon.json<{ user: { id: string } }>()).user.id;
    const page = await (await call('/link', { jar })).text();
    expect(page).toContain('action="/link/email"');

    const email = uniqueEmail('ui-upgrade');
    const res = await call('/link/email', { jar, form: { email, password: PASSWORD } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
    const row = await env.DB.prepare('SELECT id, isAnonymous FROM "user" WHERE email = ?').bind(email).first();
    expect(row).toEqual({ id: anonId, isAnonymous: 0 });
  });

  it('consent page: allow returns a code, deny returns access_denied', async () => {
    await seedProduct('product_c');
    await asSystem(() =>
      registerProductClient(auth(), new Headers(), { productId: 'product_c', env: 'prod', redirectUris: [REDIRECT('product_c')], skipConsent: false }),
    );
    for (const accept of ['true', 'false']) {
      const jar = new CookieJar();
      await signUp(jar);
      const consent = await startAuthorize(jar, 'product_c');
      expect(consent.pathname).toBe('/consent');
      const page = await (await call(`${consent.pathname}${consent.search}`, { jar })).text();
      expect(page).toContain('product_c.prod');
      const res = await call('/consent', { jar, form: { accept, oauth_query: hidden(page, 'oauth_query')! } });
      expect(res.status).toBe(302);
      const cb = new URL(res.headers.get('location')!);
      expect(`${cb.origin}${cb.pathname}`).toBe(REDIRECT('product_c'));
      if (accept === 'true') expect(cb.searchParams.get('code')).toBeTruthy();
      else expect(cb.searchParams.get('error')).toBe('access_denied');
    }
  });
});
