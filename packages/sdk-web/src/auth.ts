import { clientId, productAudience, type MeResponse } from '@z-cloudbase/contracts';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from 'jose';
import { DEFAULT_TIMEOUT_MS, validateConfig, type ClientConfig, type KeyValueStore } from './config.ts';
import { PlatformError } from './errors.ts';
import { createHttp, fetchWithTimeout } from './http.ts';

export interface AuthUser {
  id: string;
  /**
   * Set during a platform support session (impersonation, PRD §21.5.2): the user id of the platform owner
   * acting as this user (the token's RFC 8693 `act.sub`). Show a notice, and let the backend refuse
   * sensitive operations (it sees the same `act` claim in the access token).
   */
  actor?: string;
}

const actorOf = (claims: object) => {
  const sub = ((claims as { act?: unknown }).act as { sub?: unknown } | undefined)?.sub;
  return typeof sub === 'string' ? { actor: sub } : {};
};

/** `GET /v1/me` body (packages/contracts `MeResponse`). */
export type Me = MeResponse;

export type Auth = ReturnType<typeof createAuth>;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface Transaction {
  state: string;
  nonce: string;
  verifier: string;
}

/** Refresh this long before expiry so a token never dies in flight. */
const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_EXPIRES_IN_S = 15 * 60;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const s256 = async (v: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));

/** sessionStorage can be missing or throw (private mode, SSR); the transaction then cannot survive the redirect. */
function txStore(): KeyValueStore {
  try {
    if (globalThis.sessionStorage) return globalThis.sessionStorage;
  } catch {
    // fall through
  }
  throw new PlatformError('sdk_error', 'sessionStorage is required to complete a redirect sign-in');
}

export function createAuth(config: ClientConfig) {
  validateConfig(config);
  const cid = clientId(config.productId, config.env);
  const issuer = config.issuer.replace(/\/+$/, '');
  const f: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const txKey = `zcb.${cid}.tx`;
  const rtKey = `zcb.${cid}.refresh_token`;

  let session: { accessToken: string; expiresAt: number; userId: string } | null = null;
  let refreshToken: string | null = null;
  let inflight: Promise<string | null> | null = null;
  let discovery: Promise<{ d: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }> | null = null;
  const listeners = new Set<(user: AuthUser | null) => void>();

  const http = createHttp(config, () => getAccessToken());

  function emit(user: AuthUser | null) {
    for (const cb of [...listeners]) {
      try {
        cb(user);
      } catch {
        // a listener must not break auth
      }
    }
  }

  function loadRefreshToken(): string | null {
    if (refreshToken) return refreshToken;
    try {
      refreshToken = config.storage?.getItem(rtKey) ?? null;
    } catch {
      refreshToken = null;
    }
    return refreshToken;
  }

  function storeRefreshToken(token: string | null) {
    refreshToken = token;
    try {
      if (token) config.storage?.setItem(rtKey, token);
      else config.storage?.removeItem(rtKey);
    } catch {
      // memory copy still works for this page
    }
  }

  function discover() {
    discovery ??= (async () => {
      const res = await fetchWithTimeout(f, `${issuer}/.well-known/openid-configuration`, {}, timeoutMs);
      if (!res.ok) throw new PlatformError('sdk_error', `OIDC discovery failed (HTTP ${res.status})`, { retryable: res.status >= 500 });
      const d = (await res.json()) as Discovery;
      if (d.issuer !== issuer || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
        throw new PlatformError('sdk_error', 'OIDC discovery document does not match the configured issuer');
      }
      const jwks = createRemoteJWKSet(new URL(d.jwks_uri), { [customFetch]: (url, init) => f(url, init) });
      return { d, jwks };
    })();
    discovery.catch(() => (discovery = null));
    return discovery;
  }

  /** Token / revocation endpoints speak RFC 6749 errors, not the platform ErrorBody. */
  async function oidcPost(url: string, params: Record<string, string>): Promise<unknown> {
    const res = await fetchWithTimeout(f, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    }, timeoutMs);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let body: { error?: string; error_description?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON error
      }
      throw new PlatformError(body.error ?? (res.status >= 500 ? 'unavailable' : 'invalid_request'),
        body.error_description ?? `Token endpoint returned HTTP ${res.status}`,
        { status: res.status, retryable: res.status >= 500 || res.status === 429 });
    }
    return text ? JSON.parse(text) : undefined;
  }

  function startSession(t: TokenResponse, userId: string) {
    if (typeof t.access_token !== 'string') throw new PlatformError('sdk_error', 'Token response has no access_token');
    session = {
      accessToken: t.access_token,
      expiresAt: Date.now() + (t.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000,
      userId,
    };
    // Refresh tokens rotate: the previous one is dead the moment a new one is issued.
    if (t.refresh_token) storeRefreshToken(t.refresh_token);
  }

  function endSession() {
    session = null;
    storeRefreshToken(null);
  }

  function peekAccessToken(): string | null {
    return session && session.expiresAt - Date.now() > EXPIRY_SKEW_MS ? session.accessToken : null;
  }

  // Never retried automatically: if the server rotated but the response was lost, replaying the old
  // refresh token would be treated as theft and revoke every token of this client.
  async function refresh(): Promise<string | null> {
    const rt = loadRefreshToken();
    if (!rt) return null;
    const { d } = await discover();
    let t: TokenResponse;
    try {
      t = (await oidcPost(d.token_endpoint, {
        grant_type: 'refresh_token', refresh_token: rt, client_id: cid,
      })) as TokenResponse;
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'invalid_grant') {
        const wasSignedIn = session !== null;
        endSession();
        if (wasSignedIn) emit(null);
        return null;
      }
      throw e;
    }
    const firstRestore = session === null;
    // Unverified decode is fine here: the token just came from the token endpoint over TLS and
    // `sub` / `act` only feed the local user object.
    const claims = decodeJwt(t.access_token);
    startSession(t, session?.userId ?? claims.sub ?? '');
    if (firstRestore) emit({ id: session!.userId, ...actorOf(claims) });
    return t.access_token;
  }

  async function getAccessToken(): Promise<string | null> {
    const fresh = peekAccessToken();
    if (fresh) return fresh;
    inflight ??= refresh().finally(() => (inflight = null));
    return inflight;
  }

  function cleanUrl(u: URL) {
    for (const k of ['code', 'state', 'iss', 'error', 'error_description', 'error_uri']) u.searchParams.delete(k);
    try {
      globalThis.history?.replaceState(globalThis.history.state, '', u.pathname + u.search + u.hash);
    } catch {
      // not in a browser
    }
  }

  return {
    /**
     * Redirect the browser to the identity service (authorization code + PKCE S256). With `guest: true`
     * a visitor without a platform session continues as an anonymous guest instead of seeing the login
     * page (games); someone already signed in on the identity domain keeps that account.
     */
    async signInWithRedirect(opts: { guest?: boolean } = {}): Promise<void> {
      const { d } = await discover();
      const tx: Transaction = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
      const store = txStore();
      store.setItem(txKey, JSON.stringify(tx));
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: cid,
        redirect_uri: config.redirectUri,
        scope: 'openid offline_access',
        state: tx.state,
        nonce: tx.nonce,
        code_challenge: await s256(tx.verifier),
        code_challenge_method: 'S256',
        // RFC 8707: without `resource` the engine issues an opaque access token.
        resource: productAudience(cid),
      }).toString();
      globalThis.location.assign(opts.guest ? `${issuer}/guest?${new URLSearchParams({ authorize: url.toString() })}` : url.toString());
    },

    /** Complete sign-in on the redirect URI: validates state and nonce, exchanges the code, cleans the URL. */
    async handleRedirectCallback(href: string = globalThis.location.href): Promise<AuthUser> {
      const u = new URL(href);
      const p = u.searchParams;
      try {
        const store = txStore();
        const raw = store.getItem(txKey);
        store.removeItem(txKey); // single use, also on failure
        const tx = raw ? (JSON.parse(raw) as Transaction) : null;
        if (!tx) throw new PlatformError('sdk_error', 'No sign-in in progress');
        if (p.get('state') !== tx.state) throw new PlatformError('state_mismatch', 'State does not match the sign-in request');
        const err = p.get('error');
        if (err) throw new PlatformError(err, p.get('error_description') ?? 'Authorization failed');
        if (p.has('iss') && p.get('iss') !== issuer) throw new PlatformError('sdk_error', 'Unexpected issuer in callback');
        const code = p.get('code');
        if (!code) throw new PlatformError('sdk_error', 'Callback has no authorization code');

        const { d, jwks } = await discover();
        const t = (await oidcPost(d.token_endpoint, {
          grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: cid,
          code_verifier: tx.verifier,
        })) as TokenResponse;
        if (!t.id_token) throw new PlatformError('sdk_error', 'Token response has no id_token');
        let payload;
        try {
          ({ payload } = await jwtVerify(t.id_token, jwks, { issuer: d.issuer, audience: cid }));
        } catch (e) {
          // jose error codes (e.g. ERR_JWT_CLAIM_VALIDATION_FAILED + claim) say why, without the token itself.
          const reason = e as { code?: string; claim?: string; reason?: string };
          throw new PlatformError('invalid_token', 'id_token verification failed', {
            details: { reason: reason.code ?? 'unknown', ...(reason.claim ? { claim: reason.claim, check: reason.reason } : {}) },
          });
        }
        if (payload.nonce !== tx.nonce) throw new PlatformError('nonce_mismatch', 'id_token nonce does not match');
        if (!payload.sub) throw new PlatformError('invalid_token', 'id_token has no subject');

        startSession(t, payload.sub);
        const user: AuthUser = { id: payload.sub, ...actorOf(payload) };
        emit(user);
        return user;
      } finally {
        cleanUrl(u);
      }
    },

    /** Access token for the signed-in user (refreshed when near expiry); `null` when signed out. */
    getAccessToken,
    /** Synchronous: the current token if still usable. For unload paths that cannot await. */
    peekAccessToken,

    /** The signed-in user's profile from `GET /v1/me`; `null` when signed out. */
    async getUser(): Promise<Me | null> {
      if (!(await getAccessToken())) return null;
      return http<Me>('/me', { auth: 'required', retries: 2 });
    },

    async signOut(): Promise<void> {
      const rt = loadRefreshToken();
      const wasSignedIn = session !== null || rt !== null;
      endSession();
      if (wasSignedIn) emit(null);
      if (!rt) return;
      try {
        const { d } = await discover();
        if (d.revocation_endpoint) {
          await oidcPost(d.revocation_endpoint, { token: rt, token_type_hint: 'refresh_token', client_id: cid });
        }
      } catch {
        // already signed out locally; the token still expires on its own
      }
    },

    /** Subscribe to sign-in / sign-out; returns an unsubscribe function. */
    onAuthStateChange(cb: (user: AuthUser | null) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
