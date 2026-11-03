import { createRemoteJWKSet, customFetch } from 'jose';
import { PlatformError } from './errors.ts';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, resolveFetch, type ServerClientConfig } from './http.ts';

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export type Jwks = ReturnType<typeof createRemoteJWKSet>;

/** Discovery document and JWKS of the configured issuer, fetched lazily and cached. */
export function createOidc(config: ServerClientConfig) {
  const f = resolveFetch(config);
  const issuer = config.issuer.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cached: Promise<{ d: Discovery; jwks: Jwks }> | null = null;

  function discover() {
    cached ??= (async () => {
      const res = await fetchWithTimeout(f, `${issuer}/.well-known/openid-configuration`, {}, timeoutMs);
      if (!res.ok) {
        throw new PlatformError('sdk_error', `OIDC discovery failed (HTTP ${res.status})`, { retryable: res.status >= 500 });
      }
      const d = (await res.json()) as Discovery;
      if (d.issuer !== issuer || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
        throw new PlatformError('sdk_error', 'OIDC discovery document does not match the configured issuer');
      }
      return { d, jwks: createRemoteJWKSet(new URL(d.jwks_uri), { [customFetch]: (url, init) => f(url, init) }) };
    })();
    cached.catch(() => (cached = null)); // retry discovery on the next call
    return cached;
  }

  /** POST a form to an OIDC endpoint; errors follow RFC 6749, not the platform ErrorBody. */
  async function post(
    url: string, params: Record<string, string>, basic?: { id: string; secret: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (basic) {
      // RFC 6749 §2.3.1: form-urlencode both parts before base64.
      headers.Authorization = `Basic ${btoa(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`)}`;
    }
    const res = await fetchWithTimeout(f, url, { method: 'POST', headers, body: new URLSearchParams(params) }, timeoutMs);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let body: { error?: string; error_description?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON error
      }
      throw new PlatformError(body.error ?? (res.status >= 500 ? 'unavailable' : 'invalid_request'),
        body.error_description ?? `OIDC endpoint returned HTTP ${res.status}`,
        { status: res.status, retryable: res.status >= 500 || res.status === 429 });
    }
    return text ? JSON.parse(text) : undefined;
  }

  return { issuer, discover, post };
}

export type Oidc = ReturnType<typeof createOidc>;
