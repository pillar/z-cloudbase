// OIDC Authorization Code + PKCE against the identity worker (PRD §19.9). Pure functions; the
// browser glue (redirects, storage, in-memory session) lives in auth.ts.

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

type Fetch = typeof fetch;

export async function discover(issuer: string, fetchFn: Fetch = fetch): Promise<Discovery> {
  const res = await fetchFn(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const d = (await res.json()) as Partial<Discovery>;
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error('OIDC discovery document is incomplete');
  return { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint };
}

export function buildAuthorizeUrl(
  d: Discovery,
  p: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scope: string },
): string {
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    resource: p.resource,
  }).toString();
  return url.toString();
}

/** Extract the authorization code from the redirect URL; the `state` must be the one we issued. */
export function parseCallback(url: URL, expectedState: string | null): { code: string } {
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Sign-in failed: ${url.searchParams.get('error_description') ?? error}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('Sign-in response is missing code or state');
  if (!expectedState || state !== expectedState) throw new Error('Sign-in state mismatch');
  return { code };
}

async function tokenRequest(d: Discovery, form: Record<string, string>, fetchFn: Fetch, now: number): Promise<Tokens> {
  const res = await fetchFn(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) throw new Error(`Token request failed: ${body.error_description ?? body.error ?? res.status}`);
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: now + (body.expires_in ?? 900) * 1000,
  };
}

export const exchangeCode = (
  d: Discovery,
  p: { clientId: string; redirectUri: string; code: string; verifier: string; resource: string },
  fetchFn: Fetch = fetch,
  now = Date.now(),
) =>
  tokenRequest(
    d,
    { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource },
    fetchFn,
    now,
  );

export const refreshTokens = (
  d: Discovery,
  p: { clientId: string; refreshToken: string; resource: string },
  fetchFn: Fetch = fetch,
  now = Date.now(),
) => tokenRequest(d, { grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource }, fetchFn, now);
