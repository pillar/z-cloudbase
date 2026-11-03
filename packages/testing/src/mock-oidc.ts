import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';

/**
 * Test-only OIDC provider double (PRD §19.10). It plays the external IdP (Google / Apple)
 * for the identity worker: the browser leg is simulated with `authorize()` (query response)
 * or `authorizeFormPost()` (Apple's `response_mode=form_post`), and the back channel
 * (token + JWKS endpoints) is served by `handle()` behind a fetch interceptor.
 * It issues RS256 id_tokens and lets tests choose the subject, email, `email_verified`
 * (Apple sends it as a string), private-relay addresses, a wrong nonce and broken
 * id_tokens (tampered, foreign-signed, wrong claims). Never use outside tests.
 */
export interface MockIdpUser {
  sub: string;
  email: string;
  email_verified?: boolean | 'true' | 'false';
  name?: string;
  /** Extra id_token claims, e.g. Apple's `is_private_email`. */
  claims?: Record<string, unknown>;
}

/** How the id_token returned by the token endpoint is (mis)built for one authorization. */
export interface MockIdTokenOptions {
  /** Overrides/additions applied to the signed claims (e.g. `iss`, `aud`, `exp`, `nonce`). */
  claims?: Record<string, unknown>;
  /** Sign with a key the IdP never published (same `kid`). */
  foreignKey?: boolean;
  /** Change the payload after signing, so the signature no longer matches. */
  tamper?: boolean;
}

export interface MockOidcEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  jwks: string;
}

/** The real Google endpoints that Better Auth's `google` provider calls. */
export const GOOGLE_ENDPOINTS: MockOidcEndpoints = {
  issuer: 'https://accounts.google.com',
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
};

/** The real Sign in with Apple endpoints that Better Auth's `apple` provider calls. */
export const APPLE_ENDPOINTS: MockOidcEndpoints = {
  issuer: 'https://appleid.apple.com',
  authorization: 'https://appleid.apple.com/auth/authorize',
  token: 'https://appleid.apple.com/auth/token',
  jwks: 'https://appleid.apple.com/auth/keys',
};

interface PendingCode {
  user: MockIdpUser;
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  nonce: string | null;
  idToken: MockIdTokenOptions;
}

interface AuthorizeOptions {
  /** Put this nonce in the id_token instead of the one from the authorization request. */
  nonce?: string;
  idToken?: MockIdTokenOptions;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createMockOidcProvider(endpoints: MockOidcEndpoints) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const foreign = await generateKeyPair('RS256', { extractable: true });
  const kid = `mock-${crypto.randomUUID()}`;
  const jwks: JSONWebKeySet = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };
  const codes = new Map<string, PendingCode>();
  const tokenRequests: URLSearchParams[] = [];

  /** Validates the authorization request and records the code the IdP will hand back. */
  function approve(authorizationUrl: string, user: MockIdpUser, opts: AuthorizeOptions) {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== endpoints.authorization) throw new Error(`not this IdP: ${url}`);
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientId = url.searchParams.get('client_id');
    if (!redirectUri || !clientId) throw new Error('authorization request without redirect_uri / client_id');
    const code = crypto.randomUUID();
    codes.set(code, {
      user,
      clientId,
      redirectUri,
      challenge: url.searchParams.get('code_challenge'),
      nonce: opts.nonce ?? url.searchParams.get('nonce'),
      idToken: opts.idToken ?? {},
    });
    return { url, code, redirectUri, state: url.searchParams.get('state') };
  }

  /** Simulates the user approving at the IdP; returns the query-mode redirect back to the RP. */
  function authorize(authorizationUrl: string, user: MockIdpUser, opts: AuthorizeOptions = {}): string {
    const { url, code, redirectUri, state } = approve(authorizationUrl, user, opts);
    if (url.searchParams.get('response_mode') === 'form_post') throw new Error('form_post request: use authorizeFormPost()');
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    return back.toString();
  }

  /**
   * Apple-style `response_mode=form_post`: the IdP page auto-submits a cross-site POST to the
   * RP callback. Returns the form target and fields (Apple adds the `user` JSON on first consent).
   */
  function authorizeFormPost(authorizationUrl: string, user: MockIdpUser, opts: AuthorizeOptions = {}) {
    const { url, code, redirectUri, state } = approve(authorizationUrl, user, opts);
    if (url.searchParams.get('response_mode') !== 'form_post') throw new Error('not a form_post request');
    const form = new URLSearchParams({ code });
    if (state) form.set('state', state);
    if (user.name) {
      const [firstName = '', lastName = ''] = user.name.split(' ');
      form.set('user', JSON.stringify({ name: { firstName, lastName }, email: user.email }));
    }
    return { action: redirectUri, form };
  }

  async function signIdToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: endpoints.issuer,
      aud: pending.clientId,
      sub: pending.user.sub,
      iat: now,
      exp: now + 3600,
      email: pending.user.email,
      email_verified: pending.user.email_verified ?? true,
      name: pending.user.name ?? 'Mock User',
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
      ...pending.user.claims,
      ...pending.idToken.claims,
    };
    const key = pending.idToken.foreignKey ? foreign.privateKey : privateKey;
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
    if (!pending.idToken.tamper) return token;
    const [header, , signature] = token.split('.');
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ ...claims, sub: `${pending.user.sub}-forged` })));
    return `${header}.${forged}.${signature}`;
  }

  async function token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    tokenRequests.push(form);
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    codes.delete(code); // one-time use
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    if (!pending || form.get('redirect_uri') !== pending.redirectUri) return fail('invalid_grant');
    if (pending.challenge) {
      const verifier = form.get('code_verifier') ?? '';
      const digest = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      if (digest !== pending.challenge) return fail('invalid_grant');
    }
    return Response.json({
      access_token: crypto.randomUUID(),
      id_token: await signIdToken(pending),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
    });
  }

  /** Back-channel handler; returns undefined for URLs that are not this IdP's. */
  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> {
    const req = new Request(input, init);
    const url = `${new URL(req.url).origin}${new URL(req.url).pathname}`;
    if (url === endpoints.token && req.method === 'POST') return token(req);
    if (url === endpoints.jwks) return Response.json(jwks);
    return undefined;
  }

  return { endpoints, jwks, authorize, authorizeFormPost, handle, tokenRequests };
}

export type MockOidcProvider = Awaited<ReturnType<typeof createMockOidcProvider>>;

/**
 * Wraps a fetch implementation so requests to the given mock IdPs are answered locally and
 * everything else is rejected (deny by default). Install it over `globalThis.fetch` in tests only.
 */
export function interceptFetch(original: typeof fetch, providers: MockOidcProvider[]): typeof fetch {
  return async (input, init) => {
    for (const p of providers) {
      const res = await p.handle(input instanceof Request ? input.clone() : input, init);
      if (res) return res;
    }
    // Deny by default: a test must never reach a real provider (or any other network host).
    void original;
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`interceptFetch: blocked outbound request to ${url} (no mock provider matched)`);
  };
}
