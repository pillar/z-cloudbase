import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { ClientConfig, KeyValueStore } from '../src/config.ts';

export const ISSUER = 'http://identity.test';
export const ENDPOINT = 'http://api.test';
export const PK = `pk_dev_${'a'.repeat(33)}`;
export const REDIRECT = 'http://app.test/callback';
export const CLIENT_ID = 'product_a.dev';

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  init: RequestInit;
  json: () => any;
  form: () => URLSearchParams;
}

/** Fake fetch that records every request and answers through `handler`. */
export function fakeFetch(handler: (r: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null;
    const r: Recorded = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body,
      init,
      json: () => JSON.parse(body ?? 'null'),
      form: () => new URLSearchParams(body ?? ''),
    };
    calls.push(r);
    return handler(r);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const apiError = (code: string, status: number, retryable = false) =>
  json({ error: { code, message: code, request_id: 'req_test', retryable } }, status);

export function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export const baseConfig = (over: Partial<ClientConfig> = {}): ClientConfig => ({
  endpoint: ENDPOINT,
  issuer: ISSUER,
  productId: 'product_a',
  env: 'dev',
  publishableKey: PK,
  redirectUri: REDIRECT,
  retryBaseMs: 1,
  ...over,
});

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A working OIDC provider double: discovery, JWKS, authorization-code + PKCE verification,
 * rotating refresh tokens with reuse detection, and revocation.
 */
export async function createFakeIdp() {
  const key = await generateKeyPair('EdDSA', { extractable: true });
  const other = await generateKeyPair('EdDSA', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'EdDSA' };
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; userId: string }>();
  const refreshTokens = new Map<string, string>(); // token -> userId
  const idp = {
    userId: 'usr_test',
    /** Next id_token: override its nonce, or sign with a key that is not in the JWKS. */
    nonceOverride: null as string | null,
    forgeIdToken: false,
    expiresIn: 900,
    tokenCalls: 0,
    revoked: [] as string[],
    failToken: null as Response | null,
    issued: [] as string[],

    /** The browser leg: validates the authorize URL like an IdP would and returns the callback URL. */
    authorize(authorizeUrl: string, userId = 'usr_test'): string {
      const u = new URL(authorizeUrl);
      const p = u.searchParams;
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256') throw new Error('bad authorize request');
      const code = `code_${codes.size}_${Math.random().toString(36).slice(2)}`;
      codes.set(code, { challenge: p.get('code_challenge')!, nonce: p.get('nonce')!, redirectUri: p.get('redirect_uri')!, userId });
      const cb = new URL(p.get('redirect_uri')!);
      cb.searchParams.set('code', code);
      cb.searchParams.set('state', p.get('state')!);
      return cb.toString();
    },

    async accessToken(userId: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: 'at+jwt' })
        .setIssuer(ISSUER).setSubject(userId).setAudience(`urn:platform:${CLIENT_ID}`)
        .setIssuedAt(now).setExpirationTime(now + idp.expiresIn).setJti(crypto.randomUUID())
        .sign(key.privateKey);
    },

    async issue(userId: string, nonce?: string): Promise<Response> {
      const refresh = `rt_${refreshTokens.size}_${Math.random().toString(36).slice(2)}`;
      refreshTokens.set(refresh, userId);
      const access = await idp.accessToken(userId);
      idp.issued.push(refresh);
      const body: Record<string, unknown> = { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: idp.expiresIn };
      if (nonce !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        body.id_token = await new SignJWT({ nonce: idp.nonceOverride ?? nonce })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
          .setIssuer(ISSUER).setSubject(userId).setAudience(CLIENT_ID).setIssuedAt(now).setExpirationTime(now + 300)
          .sign(idp.forgeIdToken ? other.privateKey : key.privateKey);
      }
      return json(body);
    },

    handler: async (r: Recorded): Promise<Response> => {
      const u = new URL(r.url);
      if (u.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${ISSUER}/api/auth/jwks`,
          revocation_endpoint: `${ISSUER}/api/auth/oauth2/revoke`,
        });
      }
      if (u.pathname === '/api/auth/jwks') return json({ keys: [jwk] });
      if (u.pathname === '/api/auth/oauth2/token') {
        idp.tokenCalls++;
        if (idp.failToken) return idp.failToken.clone();
        const f = r.form();
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          codes.delete(f.get('code') ?? '');
          const verifier = f.get('code_verifier') ?? '';
          const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
          if (!c || c.redirectUri !== f.get('redirect_uri') || c.challenge !== challenge || f.get('client_id') !== CLIENT_ID) {
            return json({ error: 'invalid_grant' }, 400);
          }
          return idp.issue(c.userId, c.nonce);
        }
        if (f.get('grant_type') === 'refresh_token') {
          const old = f.get('refresh_token') ?? '';
          const userId = refreshTokens.get(old);
          if (!userId) {
            refreshTokens.clear(); // reuse detection: everything for the client dies
            return json({ error: 'invalid_grant', error_description: 'refresh token reused' }, 400);
          }
          refreshTokens.delete(old);
          return idp.issue(userId);
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }
      if (u.pathname === '/api/auth/oauth2/revoke') {
        idp.revoked.push(r.form().get('token')!);
        return new Response(null, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  };
  return idp;
}
