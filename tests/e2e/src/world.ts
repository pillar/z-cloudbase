// Shared e2e helpers: the running stack (from globalSetup), identity sign-up / console login,
// admin API calls, product setup and Web SDK apps on simulated browser tabs.
import { createHash, randomBytes } from 'node:crypto';
import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID, type Environment } from '@z-cloudbase/contracts';
import { createClient, type ClientConfig } from '@z-cloudbase/web';
import { inject } from 'vitest';
import { d1, type StackInfo } from '../local-stack/stack.ts';
import { Browser, Tab, type Login } from './browser.ts';
import { CONSOLE_ORIGIN, PASSWORD } from './constants.ts';

export const stack = (): StackInfo => inject('stack');
export const owner = () => inject('owner');
/** The owner's console token, obtained once in globalSetup (valid for the 15-minute access-token TTL). */
export const ownerToken = () => inject('owner').consoleToken;
export { CONSOLE_ORIGIN, PASSWORD };

let n = 0;
export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${++n}-${randomBytes(3).toString('hex')}@example.test`;
/** Product ids must be unique across runs only within one fresh state; a random suffix keeps files independent. */
export const uniqueProductId = (tag: string) => `${tag}_${randomBytes(3).toString('hex')}`;

export async function poll<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// --- identity ------------------------------------------------------------------------------

/** Register through the identity worker's engine endpoint (sign-up never signs in), then sign in. */
export async function signUp(browser: Browser, email = uniqueEmail('user'), password = PASSWORD): Promise<{ email: string; password: string; userId: string }> {
  const res = await browser.request(`${stack().issuer}/api/auth/sign-up/email`, { json: { email, password, name: '' } });
  if (res.status !== 200) throw new Error(`sign-up failed ${res.status}: ${await res.text()}`);
  return { email, password, userId: await signIn(browser, email, password) };
}

export async function signIn(browser: Browser, email: string, password = PASSWORD): Promise<string> {
  const res = await browser.request(`${stack().issuer}/api/auth/sign-in/email`, { json: { email, password } });
  if (res.status !== 200) throw new Error(`sign-in failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { user: { id: string } }).user.id;
}

export async function session(browser: Browser): Promise<{ user: { id: string; isAnonymous?: boolean; email: string } } | null> {
  const res = await browser.request(`${stack().issuer}/api/auth/get-session`);
  return (await res.json()) as { user: { id: string; isAnonymous?: boolean; email: string } } | null;
}

/** Mail written by the identity worker's local outbox adapter (PRD §19.10), newest first. */
export async function outbox(to: string) {
  const rows = await d1<{ template: string; payload: string }>(stack(), 'platform',
    'SELECT template, payload FROM email_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC', [to]);
  return rows.map((r) => ({ template: r.template, payload: JSON.parse(r.payload) as Record<string, string> }));
}

// --- OIDC (raw, for token-level checks) -------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64url');
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export async function tokenRequest(params: Record<string, string>, issuer = stack().issuer): Promise<Response> {
  return fetch(`${issuer}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
  });
}

/** Authorization code + PKCE for any client, driven through the browser (login form when needed). */
export async function authorizeCode(
  browser: Browser,
  o: { clientId: string; redirectUri: string; resource: string; scope?: string; login?: Login },
): Promise<{ callback: URL; tokens?: TokenSet; tokenResponse?: Response }> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const url = new URL(`${browser.issuer}/api/auth/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: o.clientId, redirect_uri: o.redirectUri, scope: o.scope ?? 'openid offline_access',
    state, nonce: b64url(randomBytes(16)), code_challenge: challenge, code_challenge_method: 'S256', resource: o.resource,
  }).toString();
  const callback = await browser.authorize(url.toString(), o.login);
  if (callback.searchParams.get('state') !== state) throw new Error('state mismatch');
  const code = callback.searchParams.get('code');
  if (!code) return { callback };
  const tokenResponse = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: o.redirectUri, client_id: o.clientId, code_verifier: verifier,
  }, browser.issuer);
  if (tokenResponse.status !== 200) return { callback, tokenResponse };
  return { callback, tokens: (await tokenResponse.json()) as TokenSet };
}

/**
 * Console (platform_console) access token for a signed-up admin. Each call is a password sign-in,
 * which counts against the per-account limit (5 / minute): reuse tokens, e.g. `ownerToken()`.
 * TOTP is optional for administrators by default (PRD §19.11): an admin who enrolled it answers the
 * code prompt with `login.totp`; with REQUIRE_ADMIN_2FA the first call enrolls it.
 */
export async function consoleToken(login: Login, issuer = stack().issuer): Promise<string> {
  login.totp ??= {};
  const browser = new Browser(issuer);
  const r = await authorizeCode(browser, { clientId: CONSOLE_CLIENT_ID, redirectUri: `${CONSOLE_ORIGIN}/`, resource: CONSOLE_AUDIENCE, login });
  if (!r.tokens) throw new Error(`console login failed: ${r.tokenResponse?.status} ${await r.tokenResponse?.text()}`);
  return r.tokens.access_token;
}

// --- api -----------------------------------------------------------------------------------

export async function api(path: string, o: { method?: string; key?: string; token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.key) headers['X-Platform-Key'] = o.key;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${stack().apiOrigin}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
}

export async function admin<T = any>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await api(`/v1/admin${path}`, { method, token, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export async function errorOf(res: Response): Promise<{ code: string; message: string; request_id: string }> {
  return ((await res.json()) as { error: { code: string; message: string; request_id: string } }).error;
}

// --- products ------------------------------------------------------------------------------

export interface ProductEnv {
  productId: string;
  env: Environment;
  clientId: string;
  publishableKey: string;
  appOrigin: string;
  redirectUri: string;
}

let appPort = 6100;
/** A product with its three environments, registered OIDC clients and an app origin of its own. */
export async function createProduct(ownerToken: string, productId: string, o: { visibility?: 'open' | 'restricted'; name?: string } = {}) {
  const appOrigin = `http://localhost:${appPort++}`;
  const redirectUri = `${appOrigin}/callback`;
  const r = await admin<{ id: string; environments: Array<{ env: Environment; publishable_key: string }> }>(ownerToken, 'POST', '/products', {
    product_id: productId, name: o.name ?? productId, visibility: o.visibility ?? 'open', redirect_uris: [redirectUri], allowed_origins: [appOrigin],
  });
  if (r.status !== 201) throw new Error(`create product ${productId}: ${r.status} ${JSON.stringify(r.body)}`);
  const env = (e: Environment): ProductEnv => ({
    productId, env: e, clientId: `${productId}.${e}`, appOrigin, redirectUri,
    publishableKey: r.body.environments.find((x) => x.env === e)!.publishable_key,
  });
  return { productId, appOrigin, redirectUri, prod: env('prod'), dev: env('dev'), raw: r.body };
}

export async function createBucket(ownerToken: string, p: ProductEnv, name: string) {
  const r = await admin(ownerToken, 'POST', `/products/${p.productId}/environments/${p.env}/buckets`, { name });
  if (r.status !== 201) throw new Error(`create bucket: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function createServiceKey(ownerToken: string, p: ProductEnv, scopes: string[]): Promise<string> {
  const r = await admin<{ key: string }>(ownerToken, 'POST', `/products/${p.productId}/service-keys`, { env: p.env, scopes });
  if (r.status !== 201) throw new Error(`create service key: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.key;
}

// --- Web SDK on a browser tab ----------------------------------------------------------------

export type WebApp = ReturnType<typeof createWebApp>;

/** `createClient` for one product env, running in a tab on the product's app origin. */
export function createWebApp(browser: Browser, p: ProductEnv, o: { persistRefreshToken?: boolean; tab?: Tab } = {}) {
  const tab = o.tab ?? new Tab(browser, p.appOrigin);
  tab.activate();
  const config: ClientConfig = {
    endpoint: stack().apiOrigin, issuer: stack().issuer, productId: p.productId, env: p.env,
    publishableKey: p.publishableKey, redirectUri: p.redirectUri, fetch: tab.fetch, retryBaseMs: 10,
    ...(o.persistRefreshToken ? { storage: tab.sessionStorage } : {}),
  };
  const sdk = createClient({ ...config, analytics: { flushIntervalMs: 0, storage: tab.localStorage } });
  return {
    tab, sdk, product: p,
    /** signInWithRedirect → identity domain (login form if needed, or the guest entry) → handleRedirectCallback. */
    async signIn(login?: Login, opts: { guest?: boolean } = {}) {
      tab.activate();
      tab.assigned = null;
      await sdk.auth.signInWithRedirect(opts);
      if (!tab.assigned) throw new Error('SDK did not navigate to the identity domain');
      const callback = await browser.authorize(tab.assigned, login);
      tab.href = callback.toString();
      tab.activate();
      return sdk.auth.handleRedirectCallback(callback.toString());
    },
  };
}

/** A fresh browser and Email/Password user. */
export async function newUser(tag = 'user') {
  const browser = new Browser(stack().issuer);
  const u = await signUp(browser, uniqueEmail(tag));
  const login: Login = { email: u.email, password: u.password };
  return { browser, ...u, login };
}
