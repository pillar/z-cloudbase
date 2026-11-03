// PRD §15 items 2, 3, 5, 6, 7: one registration + SSO across products with the Web SDK, Email /
// Password register-verify-reset-login through the identity pages and the outbox, anonymous login
// and in-place upgrade, credential conflicts are never merged, A's token is useless at B.
import { decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { Browser, inputValue } from '../src/browser.ts';
import {
  PASSWORD, admin, api, createProduct, createWebApp, errorOf, outbox, ownerToken as ownerConsoleToken, session, signIn, stack, uniqueEmail,
  uniqueProductId,
} from '../src/world.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;
let b: Awaited<ReturnType<typeof createProduct>>;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  a = await createProduct(ownerToken, uniqueProductId('sa'));
  b = await createProduct(ownerToken, uniqueProductId('sb'));
});

const issuer = () => stack().issuer;

/** Register through the server-rendered form, exactly like a person in a browser. */
async function registerWithForm(browser: Browser, email: string, password = PASSWORD) {
  const page = await browser.request(`${issuer()}/register`);
  expect(page.status).toBe(200);
  const res = await browser.request(`${issuer()}/register`, { form: { email, password, oauth_query: '' } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Check your inbox');
}

async function memberships(userId: string) {
  const r = await admin<{ memberships: Array<{ product_id: string; status: string }> }>(ownerToken, 'GET', `/users?user_id=${userId}`);
  return r.body.memberships.map((m) => `${m.product_id}:${m.status}`).sort();
}

describe('§15-2 one registration, SSO into a second product', () => {
  it('U signs up once, signs into A (password prompt), then into B without a second prompt; same user_id, separate memberships', async () => {
    const browser = new Browser(issuer());
    const email = uniqueEmail('sso');
    await registerWithForm(browser, email);

    const appA = createWebApp(browser, a.prod);
    const userA = await appA.signIn({ email, password: PASSWORD });
    expect(browser.loginPrompts).toHaveLength(1);

    const appB = createWebApp(browser, b.prod);
    const userB = await appB.signIn(); // throws if the identity domain asks for a password
    expect(browser.loginPrompts).toHaveLength(1);
    expect(userB.id).toBe(userA.id);

    appA.tab.activate();
    const meA = await appA.sdk.auth.getUser();
    appB.tab.activate();
    const meB = await appB.sdk.auth.getUser();
    expect(meA).toMatchObject({ user_id: userA.id, product_id: a.productId, env: 'prod', anonymous: false, membership: { status: 'active' } });
    expect(meB).toMatchObject({ user_id: userA.id, product_id: b.productId });
    expect(JSON.stringify(meA)).not.toContain(b.productId);
    expect(await memberships(userA.id)).toEqual([`${a.productId}:active`, `${b.productId}:active`].sort());

    // Different audiences per product (PRD §19.3).
    const tokenA = decodeJwt((await appA.sdk.auth.getAccessToken())!);
    const tokenB = decodeJwt((await appB.sdk.auth.getAccessToken())!);
    expect(tokenA.aud).toContain(`urn:platform:${a.productId}.prod`);
    expect(tokenB.aud).toContain(`urn:platform:${b.productId}.prod`);
    expect(tokenA.aud).not.toContain(`urn:platform:${b.productId}.prod`);
  });
});

describe('§15-7 A token at B', () => {
  it("is rejected with 401 at B's API without revealing anything about A or the user", async () => {
    const browser = new Browser(issuer());
    const email = uniqueEmail('cross');
    await registerWithForm(browser, email);
    const appA = createWebApp(browser, a.prod);
    const user = await appA.signIn({ email, password: PASSWORD });
    const tokenA = (await appA.sdk.auth.getAccessToken())!;
    for (const [path, init] of [
      ['/v1/me', {}],
      ['/v1/me/requests', {}],
      ['/v1/storage/objects?bucket=files', {}],
      ['/v1/storage/downloads', { body: { object_id: 'obj_x' } }],
    ] as const) {
      const res = await api(path, { key: b.prod.publishableKey, token: tokenA, ...init });
      expect([path, res.status]).toEqual([path, 401]);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('invalid_token');
      for (const leak of [a.productId, user.id, email]) expect(text).not.toContain(leak);
    }
    // A user with a B membership but A's token is still refused at B (audience, not membership, decides).
    const appB = createWebApp(browser, b.prod);
    await appB.signIn();
    expect((await api('/v1/me', { key: b.prod.publishableKey, token: tokenA })).status).toBe(401);
    // A's dev key does not accept A's prod token either.
    expect((await api('/v1/me', { key: a.dev.publishableKey, token: tokenA })).status).toBe(401);
  });
});

describe('§15-3 Email / Password: register, verify, reset, login', () => {
  it('verifies the address from the outbox link, resets the password from the outbox link and signs in with the new one only', async () => {
    const browser = new Browser(issuer());
    const email = uniqueEmail('mail');
    await registerWithForm(browser, email);

    const verify = (await outbox(email)).find((m) => m.template === 'verify_email');
    expect(verify).toBeDefined();
    const v = await browser.request(verify!.payload.url!);
    expect([200, 302]).toContain(v.status);
    const userId = await signIn(browser, email);
    const looked = await admin<{ user: { email_verified: boolean } }>(ownerToken, 'GET', `/users?user_id=${userId}`);
    expect(looked.body.user.email_verified).toBe(true);

    // Forgot password through the identity page; the answer never says whether the address exists.
    const other = new Browser(issuer());
    const forgot = await other.request(`${issuer()}/forgot-password`, { form: { email } });
    const unknown = await other.request(`${issuer()}/forgot-password`, { form: { email: uniqueEmail('nobody') } });
    expect(await forgot.text()).toBe(await unknown.text());

    const reset = (await outbox(email)).find((m) => m.template === 'reset_password');
    expect(reset).toBeDefined();
    const link = await other.request(reset!.payload.url!);
    expect(link.status).toBe(302);
    const resetPage = new URL(link.headers.get('location')!, issuer());
    expect(resetPage.pathname).toBe('/reset-password');
    const form = await other.request(resetPage.toString());
    const token = inputValue(await form.text(), 'token');
    expect(token).toBeTruthy();
    const NEW = 'a brand new passphrase';
    const done = await other.request(`${issuer()}/reset-password`, { form: { token: token!, password: NEW } });
    expect(done.status).toBe(200);

    // The session from before the reset is gone (revokeSessionsOnPasswordReset).
    expect(await session(browser)).toBeNull();
    const fresh = new Browser(issuer());
    await expect(signIn(fresh, email, PASSWORD)).rejects.toThrow(/401/);
    expect(await signIn(fresh, email, NEW)).toBe(userId);
    // The reset link is single use.
    const again = await other.request(`${issuer()}/reset-password`, { form: { token: token!, password: 'yet another passphrase' } });
    expect(again.status).toBe(400);
  });

  it('does not reveal on sign-up whether an address is already registered', async () => {
    const email = uniqueEmail('dupe');
    const first = new Browser(issuer());
    await registerWithForm(first, email);
    const second = new Browser(issuer());
    await registerWithForm(second, email); // same page as for a new address
    expect((await outbox(email)).map((m) => m.template)).toContain('existing_account');
  });
});

describe('§15-5 / §15-6 anonymous login, upgrade, conflicts', () => {
  async function anonymousBrowser() {
    const browser = new Browser(issuer());
    const res = await browser.request(`${issuer()}/api/auth/sign-in/anonymous`, { json: {} });
    expect(res.status).toBe(200);
    return { browser, userId: ((await res.json()) as { user: { id: string } }).user.id };
  }

  it('an anonymous session gets a stable global id and product memberships; upgrading to Email keeps the id and memberships', async () => {
    const { browser, userId } = await anonymousBrowser();
    const appA = createWebApp(browser, a.prod);
    const guest = await appA.signIn(); // SSO with the anonymous identity session, no prompt
    expect(guest.id).toBe(userId);
    expect(decodeJwt((await appA.sdk.auth.getAccessToken())!).anon).toBe(true);
    const appB = createWebApp(browser, b.prod);
    expect((await appB.signIn()).id).toBe(userId);
    expect((await session(browser))!.user.id).toBe(userId); // stable across requests

    const email = uniqueEmail('upgrade');
    const link = await browser.request(`${issuer()}/link/email`, { json: { email, password: PASSWORD } });
    expect(link.status).toBe(200);
    expect(await link.json()).toEqual({ user_id: userId });

    expect(await memberships(userId)).toEqual([`${a.productId}:active`, `${b.productId}:active`].sort());
    // A new product session for the upgraded user: same sub, anon=false; the new password works.
    const fresh = new Browser(issuer());
    const again = createWebApp(fresh, a.prod);
    expect((await again.signIn({ email, password: PASSWORD })).id).toBe(userId);
    expect(decodeJwt((await again.sdk.auth.getAccessToken())!).anon).toBe(false);
    const me = await again.sdk.auth.getUser();
    expect(me).toMatchObject({ user_id: userId, anonymous: false });
  });

  it("linking an email that belongs to another account is a 409 conflict and never merges either account", async () => {
    const existing = new Browser(issuer());
    const takenEmail = uniqueEmail('taken');
    await registerWithForm(existing, takenEmail);
    const ownerId = await signIn(existing, takenEmail);

    const { browser, userId } = await anonymousBrowser();
    const res = await browser.request(`${issuer()}/link/email`, { json: { email: takenEmail, password: 'attacker passphrase' } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('identity_conflict');

    // The anonymous account is unchanged, the existing one still signs in with its own password only.
    const s = await session(browser);
    expect(s!.user).toMatchObject({ id: userId, isAnonymous: true });
    expect(await signIn(new Browser(issuer()), takenEmail, PASSWORD)).toBe(ownerId);
    await expect(signIn(new Browser(issuer()), takenEmail, 'attacker passphrase')).rejects.toThrow(/401/);
    // Email equality never links on sign-in either: the case-changed address is the same account, not a new one.
    const looked = await admin<{ user: { id: string } }>(ownerToken, 'GET', `/users?email=${encodeURIComponent(takenEmail.toUpperCase())}`);
    expect(looked.body.user.id).toBe(ownerId);
  });
});
