// Test-side OIDC relying party: drives Authorization Code + PKCE over HTTP against the worker.
import { clientId, type Environment } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { registerProductClient } from '../src/clients.ts';
import { productResource } from '../src/auth.ts';
import { asSystem } from '../src/system.ts';
import { CookieJar, PASSWORD, auth, call, seedProduct } from './helpers.ts';

export const REDIRECT = (productId: string) => `https://${productId}.example.test/callback`;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkcePair() {
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/**
 * Registers `{product}.{env}` clients as the platform (system principal) and makes sure each
 * product row exists (open + active unless the test changes it).
 */
export async function setupClients(products: Array<{ productId: string; env: Environment }>) {
  const out: Record<string, Awaited<ReturnType<typeof registerProductClient>>> = {};
  for (const p of products) {
    await seedProduct(p.productId);
    out[clientId(p.productId, p.env)] = await asSystem(() =>
      registerProductClient(auth(), new Headers(), { productId: p.productId, env: p.env, redirectUris: [REDIRECT(p.productId)] }),
    );
  }
  return out;
}

export interface AuthorizeParams {
  productId: string;
  env: Environment;
  state: string;
  nonce: string;
  challenge: string;
  scope?: string;
  /** Defaults to the product resource; `null` omits the parameter. */
  resource?: string | null;
  /** A non-product client (e.g. platform_console): overrides client_id and redirect_uri. */
  client?: { id: string; redirectUri: string };
}

export function authorizeUrl(p: AuthorizeParams) {
  const id = p.client?.id ?? clientId(p.productId, p.env);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: p.client?.redirectUri ?? REDIRECT(p.productId),
    scope: p.scope ?? 'openid offline_access',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  if (p.resource !== null) q.set('resource', p.resource ?? productResource(id));
  return `/api/auth/oauth2/authorize?${q}`;
}

/**
 * authorize (no session) -> login page -> sign-in with the signed oauth_query ->
 * redirect back to the client with `code` and `state` (or an OAuth error).
 */
export async function authorizeWithLogin(jar: CookieJar, email: string, p: AuthorizeParams) {
  const first = await call(authorizeUrl(p), { jar });
  if (first.status !== 302) throw new Error(`authorize: expected redirect to login, got ${first.status} ${await first.text()}`);
  const login = new URL(first.headers.get('location')!, env.ISSUER);
  if (login.pathname !== '/login') throw new Error(`authorize: unexpected redirect ${login}`);
  const signIn = await call('/api/auth/sign-in/email', {
    jar,
    json: { email, password: PASSWORD, oauth_query: login.search.slice(1) },
  });
  if (signIn.status !== 200) throw new Error(`sign-in: ${signIn.status} ${await signIn.text()}`);
  const body = await signIn.json<{ redirect?: boolean; url?: string }>();
  if (!body.url) throw new Error(`sign-in did not continue the authorization: ${JSON.stringify(body)}`);
  return new URL(body.url);
}

/** authorize with an existing identity session (SSO into another product). */
export async function authorizeWithSession(jar: CookieJar, p: AuthorizeParams) {
  const res = await call(authorizeUrl(p), { jar });
  if (res.status !== 302) throw new Error(`authorize: ${res.status} ${await res.text()}`);
  return new URL(res.headers.get('location')!, env.ISSUER);
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export async function tokenRequest(params: Record<string, string>) {
  return call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
}

export function exchangeCode(productId: string, envName: Environment, code: string, verifier: string, client?: AuthorizeParams['client']) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: client?.id ?? clientId(productId, envName),
    redirect_uri: client?.redirectUri ?? REDIRECT(productId),
    code,
    code_verifier: verifier,
  });
}

export function refresh(productId: string, envName: Environment, refreshToken: string) {
  return tokenRequest({ grant_type: 'refresh_token', client_id: clientId(productId, envName), refresh_token: refreshToken });
}

/** Full flow for an already-registered user; returns the token response. */
export async function loginToProduct(jar: CookieJar, email: string, productId: string, envName: Environment) {
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const cb = await authorizeWithLogin(jar, email, { productId, env: envName, state, nonce: randomToken(), challenge });
  if (cb.searchParams.get('state') !== state) throw new Error('state mismatch');
  const res = await exchangeCode(productId, envName, cb.searchParams.get('code')!, verifier);
  if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
  return res.json<TokenResponse>();
}

/** SSO into a product with the jar's existing identity session; returns the token response. */
export async function ssoToProduct(jar: CookieJar, productId: string, envName: Environment = 'prod') {
  const { verifier, challenge } = await pkcePair();
  const cb = await authorizeWithSession(jar, { productId, env: envName, state: randomToken(), nonce: randomToken(), challenge });
  const code = cb.searchParams.get('code');
  if (!code) throw new Error(`authorize did not issue a code: ${cb}`);
  const res = await exchangeCode(productId, envName, code, verifier);
  if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
  return res.json<TokenResponse>();
}
