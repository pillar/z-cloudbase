import { createTestTokenMinter } from '@z-cloudbase/testing';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { ServerClientConfig } from '../src/http.ts';

export const ISSUER = 'http://identity.test';
export const ENDPOINT = 'http://api.test';
export const SK = `sk_dev_${'b'.repeat(43)}`;
export const CALLBACK = 'http://app.test/auth/callback';
export const CLIENT_ID = 'product_a.dev';
export const SECRET = 'confidential-client-secret';

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

export const baseConfig = (over: Partial<ServerClientConfig> = {}): ServerClientConfig => ({
  endpoint: ENDPOINT,
  issuer: ISSUER,
  serviceKey: SK,
  retryBaseMs: 1,
  ...over,
});

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Issuer double: discovery + JWKS (the test minter's access-token key and a separate id_token
 * key), and a confidential-client token endpoint with PKCE, secret check and rotating refresh tokens.
 */
export async function createFakeIdp(opts: { authMethods?: string[] } = {}) {
  const minter = await createTestTokenMinter(ISSUER);
  const idKey = await generateKeyPair('EdDSA', { extractable: true });
  const idJwk: JWK = { ...(await exportJWK(idKey.publicKey)), kid: 'id1', alg: 'EdDSA' };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const refreshTokens = new Set<string>();
  let counter = 0;

  const idp = {
    minter,
    idKey,
    idJwk,
    discoveryCalls: 0,
    jwksCalls: 0,
    tokenCalls: [] as Recorded[],
    revoked: [] as string[],
    nonceOverride: null as string | null,
    failRevoke: false,

    authorize(authorizeUrl: string): string {
      const p = new URL(authorizeUrl).searchParams;
      const code = `code_${counter++}`;
      codes.set(code, { challenge: p.get('code_challenge')!, nonce: p.get('nonce')! });
      const cb = new URL(p.get('redirect_uri')!);
      cb.searchParams.set('code', code);
      cb.searchParams.set('state', p.get('state')!);
      return cb.toString();
    },

    async issue(nonce?: string): Promise<Response> {
      const refresh = `rt_${counter++}`;
      refreshTokens.add(refresh);
      const body: Record<string, unknown> = {
        access_token: await minter.mint({ productId: 'product_a', env: 'dev', userId: 'usr_test' }),
        refresh_token: refresh,
        expires_in: 900,
      };
      if (nonce !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        body.id_token = await new SignJWT({ nonce: idp.nonceOverride ?? nonce })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'id1' })
          .setIssuer(ISSUER).setSubject('usr_test').setAudience(CLIENT_ID).setIssuedAt(now).setExpirationTime(now + 300)
          .sign(idKey.privateKey);
      }
      return json(body);
    },

    handler: async (r: Recorded): Promise<Response> => {
      const u = new URL(r.url);
      if (u.pathname === '/.well-known/openid-configuration') {
        idp.discoveryCalls++;
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${ISSUER}/api/auth/jwks`,
          revocation_endpoint: `${ISSUER}/api/auth/oauth2/revoke`,
          ...(opts.authMethods ? { token_endpoint_auth_methods_supported: opts.authMethods } : {}),
        });
      }
      if (u.pathname === '/api/auth/jwks') {
        idp.jwksCalls++;
        return json({ keys: [...minter.jwks.keys, idJwk] });
      }
      if (u.pathname.endsWith('/oauth2/token') || u.pathname.endsWith('/oauth2/revoke')) {
        const f = r.form();
        // client authentication: HTTP Basic or client_secret_post, secret must match
        const basic = r.headers.get('authorization');
        const [id, secret] = basic?.startsWith('Basic ')
          ? atob(basic.slice(6)).split(':').map(decodeURIComponent)
          : [f.get('client_id'), f.get('client_secret')];
        if (id !== CLIENT_ID || secret !== SECRET) return json({ error: 'invalid_client' }, 401);

        if (u.pathname.endsWith('/revoke')) {
          if (idp.failRevoke) return new Response(null, { status: 503 });
          idp.revoked.push(f.get('token')!);
          return new Response(null, { status: 200 });
        }
        idp.tokenCalls.push(r);
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          codes.delete(f.get('code') ?? '');
          const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.get('code_verifier') ?? '')));
          if (!c || c.challenge !== challenge || f.get('redirect_uri') !== CALLBACK) return json({ error: 'invalid_grant' }, 400);
          return idp.issue(c.nonce);
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (!refreshTokens.delete(f.get('refresh_token') ?? '')) {
            refreshTokens.clear();
            return json({ error: 'invalid_grant' }, 400);
          }
          return idp.issue();
        }
      }
      return new Response('not found', { status: 404 });
    },
  };
  return idp;
}
