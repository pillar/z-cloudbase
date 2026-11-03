import { ApiError, CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID, clientId, type Environment } from '@z-cloudbase/contracts';
import { OIDC_SCOPES, pendingClientId, productResource, type Auth } from './auth.ts';
import { asSystem } from './system.ts';

export interface ProductClientInput {
  productId: string;
  env: Environment;
  redirectUris: string[];
  /** Public (SPA / mobile, PKCE only) or confidential (BFF with client secret). */
  type?: 'public' | 'confidential';
  /** First-party product clients skip the consent screen. */
  skipConsent?: boolean;
  /**
   * Better Auth only accepts https, non-loopback redirect URIs for `web` clients;
   * http://localhost / 127.0.0.1 callbacks (local dev, RFC 8252 apps) need `native`.
   */
  applicationType?: 'web' | 'native';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `web` only when every redirect URI is https on a non-loopback host; otherwise RFC 8252 `native`. */
export function applicationTypeFor(redirectUris: string[]): 'web' | 'native' {
  return redirectUris.every((u) => {
    const url = new URL(u);
    return url.protocol === 'https:' && !LOOPBACK_HOSTS.has(url.hostname);
  })
    ? 'web'
    : 'native';
}

/**
 * Create the access-token resource (RFC 8707) and link it to the client, unless already done.
 * Both steps are the engine's server-only admin endpoints.
 */
async function ensureResource(auth: Auth, headers: Headers, id: string, resource: string) {
  const ctx = await auth.$context;
  const existing = await ctx.adapter.findOne({ model: 'oauthResource', where: [{ field: 'identifier', value: resource }] });
  if (!existing) await auth.api.adminCreateOAuthResource({ headers, body: { identifier: resource, name: id } });
  const link = await ctx.adapter.findOne({
    model: 'oauthClientResource',
    where: [{ field: 'clientId', value: id }, { field: 'resourceId', value: resource }],
  });
  if (!link) await auth.api.adminLinkClientResource({ headers, params: { identifier: resource, client_id: id } });
}

/**
 * Register the OIDC client `{product_id}.{env}` and its access-token resource through
 * Better Auth's server-only admin endpoints. Both endpoints require a principal: either the
 * `headers` of a signed-in platform admin, or the system principal (`asSystem`, src/system.ts).
 * Ownership is `referenceId = 'platform'` (see `clientReference` in auth.ts). RBAC is the
 * caller's job — the api worker checks console roles before calling IdentityRpc.
 */
export async function registerProductClient(auth: Auth, headers: Headers, input: ProductClientInput) {
  const id = clientId(input.productId, input.env);
  const client = await pendingClientId.run(id, () =>
    auth.api.adminCreateOAuthClient({
      headers,
      body: {
        client_name: id,
        redirect_uris: input.redirectUris,
        token_endpoint_auth_method: input.type === 'confidential' ? 'client_secret_basic' : 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: input.applicationType ?? 'web',
        scope: OIDC_SCOPES.join(' '),
        require_pkce: true,
        skip_consent: input.skipConsent ?? true,
        metadata: { product_id: input.productId, env: input.env },
      },
    }),
  );
  const resource = productResource(id);
  await ensureResource(auth, headers, id, resource);
  return { clientId: client.client_id, clientSecret: client.client_secret, resource };
}

/**
 * IdentityRpc `upsertProductClient`: register the client, or update the redirect URIs of an
 * existing one, as the system principal. The client secret is only returned on creation.
 */
export async function upsertProductClient(
  auth: Auth,
  input: { productId: string; env: Environment; redirectUris: string[]; type: 'public' | 'confidential' },
): Promise<{ clientId: string; clientSecret?: string; resource: string }> {
  const id = clientId(input.productId, input.env);
  const resource = productResource(id);
  const headers = new Headers();
  const applicationType = applicationTypeFor(input.redirectUris);
  return asSystem(async () => {
    const ctx = await auth.$context;
    const existing = await ctx.adapter.findOne<{ tokenEndpointAuthMethod: string | null }>({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: id }],
    });
    if (!existing) {
      const created = await registerProductClient(auth, headers, { ...input, applicationType });
      return { clientId: created.clientId, resource, ...(created.clientSecret ? { clientSecret: created.clientSecret } : {}) };
    }
    const isConfidential = existing.tokenEndpointAuthMethod !== 'none';
    if (isConfidential !== (input.type === 'confidential')) {
      throw new ApiError('invalid_request', 'The client type of an existing product environment cannot change');
    }
    await auth.api.adminUpdateOAuthClient({
      headers,
      body: { client_id: id, update: { redirect_uris: input.redirectUris, application_type: applicationType } },
    });
    await ensureResource(auth, headers, id, resource);
    return { clientId: id, resource };
  });
}

/**
 * The reserved console client (PRD §19.9): a plain OIDC client without product metadata whose
 * access tokens are minted for the CONSOLE_AUDIENCE resource (admin API), with no pid/env.
 */
export async function registerConsoleClient(auth: Auth, headers: Headers, redirectUris: string[]) {
  const client = await pendingClientId.run(CONSOLE_CLIENT_ID, () =>
    auth.api.adminCreateOAuthClient({
      headers,
      body: {
        client_name: CONSOLE_CLIENT_ID,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: applicationTypeFor(redirectUris),
        scope: OIDC_SCOPES.join(' '),
        require_pkce: true,
        skip_consent: true,
      },
    }),
  );
  await ensureResource(auth, headers, CONSOLE_CLIENT_ID, CONSOLE_AUDIENCE);
  return client;
}

/**
 * Register the console client, or update the redirect URIs of the existing one, as the system
 * principal (operator setup, src/setup.ts; PRD §19.9).
 */
export async function upsertConsoleClient(auth: Auth, redirectUris: string[]): Promise<{ clientId: string; resource: string }> {
  const headers = new Headers();
  return asSystem(async () => {
    const ctx = await auth.$context;
    const existing = await ctx.adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: CONSOLE_CLIENT_ID }] });
    if (!existing) {
      await registerConsoleClient(auth, headers, redirectUris);
    } else {
      await auth.api.adminUpdateOAuthClient({
        headers,
        body: { client_id: CONSOLE_CLIENT_ID, update: { redirect_uris: redirectUris, application_type: applicationTypeFor(redirectUris) } },
      });
      await ensureResource(auth, headers, CONSOLE_CLIENT_ID, CONSOLE_AUDIENCE);
    }
    return { clientId: CONSOLE_CLIENT_ID, resource: CONSOLE_AUDIENCE };
  });
}
