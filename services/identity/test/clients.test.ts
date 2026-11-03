// Programmatic OIDC client registration: one client per product env plus `platform_console`.
import { CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { registerConsoleClient, registerProductClient } from '../src/clients.ts';
import { CookieJar, auth, call, jarHeaders, signUp } from './helpers.ts';

describe('OIDC client registration', () => {
  it('registers {product}.{env} clients and platform_console with fixed client ids', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const headers = await jarHeaders(jar);

    // Web clients must use https; a local http://127.0.0.1 dev callback is only accepted as `native`.
    await expect(
      registerProductClient(auth(), headers, { productId: 'product_a', env: 'dev', redirectUris: ['http://127.0.0.1:5173/cb'] }),
    ).rejects.toMatchObject({ body: { error: 'invalid_redirect_uri' } });
    const dev = await registerProductClient(auth(), headers, {
      productId: 'product_a',
      env: 'dev',
      redirectUris: ['http://127.0.0.1:5173/cb'],
      applicationType: 'native',
    });
    const prod = await registerProductClient(auth(), headers, {
      productId: 'product_a',
      env: 'prod',
      redirectUris: ['https://a.example.test/cb'],
      type: 'confidential',
    });
    const consoleClient = await registerConsoleClient(auth(), headers, ['https://console.example.test/cb']);

    expect(dev).toMatchObject({ clientId: 'product_a.dev', resource: 'urn:platform:product_a.dev' });
    expect(dev.clientSecret).toBeUndefined(); // public client: PKCE only
    expect(prod.clientId).toBe('product_a.prod');
    expect(prod.clientSecret).toEqual(expect.any(String)); // shown once
    expect(consoleClient.client_id).toBe(CONSOLE_CLIENT_ID);

    const rows = await env.DB.prepare('SELECT clientId, clientSecret, userId, referenceId FROM oauthClient ORDER BY clientId').all<{
      clientId: string;
      clientSecret: string | null;
      userId: string | null;
      referenceId: string | null;
    }>();
    expect(rows.results.map((r) => r.clientId)).toEqual(['platform_console', 'product_a.dev', 'product_a.prod']);
    const stored = rows.results.find((r) => r.clientId === 'product_a.prod')!;
    expect(stored.clientSecret).not.toBe(prod.clientSecret); // hashed at rest
    expect(rows.results.every((r) => r.userId === null && r.referenceId === 'platform')).toBe(true);

    // A second registration of the same product env is refused (unique client id).
    await expect(
      registerProductClient(auth(), headers, { productId: 'product_a', env: 'prod', redirectUris: ['https://a.example.test/cb'] }),
    ).rejects.toThrow();
  });

  it('does not expose the admin registration endpoints over HTTP', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const res = await call('/api/auth/admin/oauth2/create-client', {
      jar,
      json: { redirect_uris: ['https://x.example.test/cb'], token_endpoint_auth_method: 'none' },
    });
    expect(res.status).toBe(404);
  });

  it('requires an identity session to register clients', async () => {
    await expect(
      registerProductClient(auth(), new Headers(), { productId: 'product_c', env: 'dev', redirectUris: ['https://c.example.test/cb'] }),
    ).rejects.toThrow();
  });
});
