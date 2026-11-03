import { REFRESH_TOKEN_TTL_S, clientId, productAudience, type Environment } from '@z-cloudbase/contracts';
import { jwtVerify } from 'jose';
import { PlatformError } from './errors.ts';
import type { Oidc } from './oidc.ts';

export interface BffOptions {
  productId: string;
  env: Environment;
  /** Confidential client secret of `{productId}.{env}`; never sent to the browser. */
  clientSecret: string;
  /** The BFF's own callback URL, registered with the identity service. */
  redirectUri: string;
  /** Set to false only for plain-http local development. */
  secureCookies?: boolean;
}

/** Cookies are ready to append as `Set-Cookie` headers. */
export interface BffTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  cookies: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

const TX_TTL_S = 10 * 60;
const DEFAULT_EXPIRES_IN_S = 15 * 60;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed cookie value: ignore it
    }
  }
  return out;
}

/**
 * Backend-for-frontend login for server-rendered apps (PRD §19.4: recommended for
 * security-sensitive products). Tokens live in HttpOnly cookies; the browser never sees them.
 */
export function createBff(oidc: Oidc, o: BffOptions) {
  const cid = clientId(o.productId, o.env);
  const secure = o.secureCookies !== false;
  const name = (kind: 'tx' | 'rt' | 'at') => `cb_${o.productId}_${o.env}_${kind}`;

  const cookie = (kind: 'tx' | 'rt' | 'at', value: string, maxAge: number) =>
    `${name(kind)}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookies = () => (['rt', 'at', 'tx'] as const).map((k) => cookie(k, '', 0));

  /** Client authentication at the token endpoint: HTTP Basic unless the issuer only offers POST. */
  async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const { d } = await oidc.discover();
    const methods = d.token_endpoint_auth_methods_supported;
    const useBasic = !methods || methods.includes('client_secret_basic');
    return (await oidc.post(
      d.token_endpoint,
      useBasic ? { ...params, client_id: cid } : { ...params, client_id: cid, client_secret: o.clientSecret },
      useBasic ? { id: cid, secret: o.clientSecret } : undefined,
    )) as TokenResponse;
  }

  function sessionCookies(t: TokenResponse): BffTokens {
    if (!t.access_token) throw new PlatformError('sdk_error', 'Token response has no access_token');
    const expiresIn = t.expires_in ?? DEFAULT_EXPIRES_IN_S;
    const cookies = [cookie('at', t.access_token, expiresIn)];
    // Rotation: always replace the stored refresh token with the one just issued.
    if (t.refresh_token) cookies.push(cookie('rt', t.refresh_token, REFRESH_TOKEN_TTL_S));
    return { accessToken: t.access_token, expiresIn, cookies };
  }

  return {
    /** Authorization URL plus the cookie that carries state, nonce and the PKCE verifier. */
    async startLogin(): Promise<{ url: string; cookies: string[] }> {
      const { d } = await oidc.discover();
      const tx = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tx.verifier))));
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: cid,
        redirect_uri: o.redirectUri,
        scope: 'openid offline_access',
        state: tx.state,
        nonce: tx.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: productAudience(cid), // RFC 8707: otherwise the access token is opaque
      }).toString();
      return { url: url.toString(), cookies: [cookie('tx', JSON.stringify(tx), TX_TTL_S)] };
    },

    /** Finish login on the callback request: checks state and nonce, exchanges the code with the client secret. */
    async handleCallback(callbackUrl: string, cookieHeader: string | null): Promise<BffTokens & { userId: string }> {
      const p = new URL(callbackUrl).searchParams;
      let tx: { state: string; nonce: string; verifier: string } | null = null;
      try {
        tx = JSON.parse(parseCookies(cookieHeader)[name('tx')] ?? 'null');
      } catch {
        // treated as missing below
      }
      if (!tx) throw new PlatformError('sdk_error', 'No sign-in in progress');
      if (p.get('state') !== tx.state) throw new PlatformError('state_mismatch', 'State does not match the sign-in request');
      const err = p.get('error');
      if (err) throw new PlatformError(err, p.get('error_description') ?? 'Authorization failed');
      if (p.has('iss') && p.get('iss') !== oidc.issuer) throw new PlatformError('sdk_error', 'Unexpected issuer in callback');
      const code = p.get('code');
      if (!code) throw new PlatformError('sdk_error', 'Callback has no authorization code');

      const t = await tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: o.redirectUri, code_verifier: tx.verifier,
      });
      if (!t.id_token) throw new PlatformError('sdk_error', 'Token response has no id_token');
      const { d, jwks } = await oidc.discover();
      let payload;
      try {
        ({ payload } = await jwtVerify(t.id_token, jwks, { issuer: d.issuer, audience: cid }));
      } catch {
        throw new PlatformError('invalid_token', 'id_token verification failed');
      }
      if (payload.nonce !== tx.nonce) throw new PlatformError('nonce_mismatch', 'id_token nonce does not match');
      if (!payload.sub) throw new PlatformError('invalid_token', 'id_token has no subject');

      const s = sessionCookies(t);
      return { ...s, userId: payload.sub, cookies: [...s.cookies, cookie('tx', '', 0)] };
    },

    /**
     * Rotate the refresh token from the request's cookies. Throws `invalid_grant` when it was
     * reused or revoked: answer 401 and send `clearCookies()`. Not retried automatically, since
     * replaying a rotated refresh token counts as theft.
     */
    async refresh(cookieHeader: string | null): Promise<BffTokens> {
      const rt = parseCookies(cookieHeader)[name('rt')];
      if (!rt) throw new PlatformError('invalid_grant', 'No refresh token cookie');
      return sessionCookies(await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }));
    },

    /** Revoke the refresh token (best effort) and return cookies that clear the session. */
    async signOut(cookieHeader: string | null): Promise<{ cookies: string[] }> {
      const rt = parseCookies(cookieHeader)[name('rt')];
      if (rt) {
        try {
          const { d } = await oidc.discover();
          if (d.revocation_endpoint) {
            const methods = d.token_endpoint_auth_methods_supported;
            const useBasic = !methods || methods.includes('client_secret_basic');
            await oidc.post(
              d.revocation_endpoint,
              useBasic ? { token: rt, token_type_hint: 'refresh_token' }
                : { token: rt, token_type_hint: 'refresh_token', client_id: cid, client_secret: o.clientSecret },
              useBasic ? { id: cid, secret: o.clientSecret } : undefined,
            );
          }
        } catch {
          // cookies are cleared regardless; the token still expires on its own
        }
      }
      return { cookies: clearCookies() };
    },

    clearCookies,
  };
}
