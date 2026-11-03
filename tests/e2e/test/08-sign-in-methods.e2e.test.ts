// PRD §21.3 / §21.4 through the whole local stack: a product signs a user in with the Web SDK via a magic
// link (outbox mail) and via a passkey (software authenticator), each through the full OIDC authorization
// flow; the identity pages follow the browser language. Remote mail delivery and real authenticators are
// not covered (remote-unverified).
import { describe, expect, it, beforeAll } from 'vitest';
import { SoftAuthenticator } from '../../../services/identity/test/webauthn.ts';
import { Browser, inputValue } from '../src/browser.ts';
import { createProduct, createWebApp, newUser, outbox, ownerToken, stack, uniqueProductId } from '../src/world.ts';

let product: Awaited<ReturnType<typeof createProduct>>;
beforeAll(async () => {
  product = await createProduct(ownerToken(), uniqueProductId('auth'));
});

const issuer = () => stack().issuer;

/** SDK redirect → identity sign-in page; returns the page's signed authorization query. */
async function startSignIn(browser: Browser) {
  const app = createWebApp(browser, product.prod);
  app.tab.assigned = null;
  await app.sdk.auth.signInWithRedirect();
  const toLogin = await browser.request(app.tab.assigned!);
  expect(toLogin.status).toBe(302);
  const login = new URL(toLogin.headers.get('location')!, issuer());
  expect(login.pathname).toBe('/login');
  const page = await (await browser.request(login.toString())).text();
  return { app, page, oauthQuery: inputValue(page, 'oauth_query') ?? '' };
}

async function finish(browser: Browser, app: ReturnType<typeof createWebApp>, authorize: string) {
  const callback = await browser.authorize(authorize); // no password: the identity session exists now
  app.tab.href = callback.toString();
  app.tab.activate();
  return app.sdk.auth.handleRedirectCallback(callback.toString());
}

describe('§21.3 magic link into a product', () => {
  it('the mailed link signs the user in and continues the authorization; the link works once', async () => {
    const { email, userId } = await newUser('magic');
    const browser = new Browser(issuer());
    const { app, page, oauthQuery } = await startSignIn(browser);
    expect(page).toContain('action="/login/magic-link"');
    const sent = await browser.request(`${issuer()}/login/magic-link`, { form: { email, oauth_query: oauthQuery } });
    expect(sent.status).toBe(200);
    const mail = (await outbox(email)).find((m) => m.template === 'magic_link')!;
    expect(mail).toBeDefined();
    const landed = await browser.request(mail.payload.url!);
    expect(landed.status).toBe(302);
    const resume = new URL(landed.headers.get('location')!, issuer());
    expect(resume.pathname).toBe('/api/auth/oauth2/authorize');
    const user = await finish(browser, app, resume.toString());
    expect(user.id).toBe(userId);
    expect(browser.loginPrompts).toHaveLength(0);

    const again = await new Browser(issuer()).request(mail.payload.url!);
    expect(new URL(again.headers.get('location')!, issuer()).pathname).toBe('/login');
  });
});

describe('§21.3 passkey into a product', () => {
  it('a passkey added on the account signs the user in from another browser through the authorization flow', async () => {
    const { browser: home, userId } = await newUser('passkey');
    const host = new URL(issuer());
    const device = new SoftAuthenticator(host.hostname, host.origin);
    const options = await (await home.request(`${issuer()}/api/auth/passkey/generate-register-options`, { headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' } })).json();
    const reg = await home.request(`${issuer()}/api/auth/passkey/verify-registration`, { json: { response: await device.create(options as never), name: 'e2e' } });
    expect(reg.status).toBe(200);

    const browser = new Browser(issuer());
    const { app, page, oauthQuery } = await startSignIn(browser);
    expect(page).toContain('data-passkey-signin');
    const auth = await (await browser.request(`${issuer()}/api/auth/passkey/generate-authenticate-options`, { headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' } })).json();
    const verify = await browser.request(`${issuer()}/api/auth/passkey/verify-authentication`, {
      json: { response: await device.get(auth as never), oauth_query: oauthQuery },
    });
    expect(verify.status).toBe(200);
    const { url } = (await verify.json()) as { url: string };
    const callback = new URL(url);
    expect(callback.origin).toBe(new URL(product.prod.redirectUri).origin);
    app.tab.href = callback.toString();
    app.tab.activate();
    const user = await app.sdk.auth.handleRedirectCallback(callback.toString());
    expect(user.id).toBe(userId);
  });
});

describe('§21.4 identity pages follow the browser language', () => {
  it('Accept-Language zh renders the sign-in page in Chinese, ?lang=en switches it back', async () => {
    const browser = new Browser(issuer());
    const zh = await (await browser.request(`${issuer()}/login`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })).text();
    expect(zh).toContain('<html lang="zh-CN">');
    const sw = await browser.request(`${issuer()}/login?lang=en`, { headers: { 'accept-language': 'zh-CN' } });
    expect(sw.status).toBe(302);
    const en = await (await browser.request(`${issuer()}/login`, { headers: { 'accept-language': 'zh-CN' } })).text();
    expect(en).toContain('<html lang="en">');
  });
});
