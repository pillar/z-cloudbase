// Cross-origin access for browser OIDC clients: public metadata for anyone, token / revoke /
// userinfo only for origins of registered redirect URIs, never with credentials.
import { beforeAll, describe, expect, it } from 'vitest';
import { call } from './helpers.ts';
import { setupClients } from './oauth-flow.ts';

const APP = 'https://product_cors.example.test';

beforeAll(async () => {
  await setupClients([{ productId: 'product_cors', env: 'prod' }]);
});

const preflight = (path: string, origin: string) =>
  call(path, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });

describe('identity CORS', () => {
  it('serves discovery and JWKS to any origin', async () => {
    for (const path of ['/.well-known/openid-configuration', '/api/auth/jwks.json']) {
      const res = await call(path, { headers: { origin: 'https://anything.example' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('answers token / revoke preflight for a registered redirect origin, without credentials', async () => {
    for (const path of ['/api/auth/oauth2/token', '/api/auth/oauth2/revoke']) {
      const res = await preflight(path, APP);
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(APP);
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const token = await call('/api/auth/oauth2/token', {
      headers: { origin: APP, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=nope&client_id=product_cors.prod',
    });
    expect(token.status).toBe(400); // the engine's answer, readable by the app
    expect(token.headers.get('access-control-allow-origin')).toBe(APP);
  });

  it('does not allow an unregistered origin on the token endpoint', async () => {
    const res = await preflight('/api/auth/oauth2/token', 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
