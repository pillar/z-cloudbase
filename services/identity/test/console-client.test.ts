// The reserved console client (PRD §19.9): JWT access tokens for CONSOLE_AUDIENCE, no pid/env,
// accepted by verifyConsoleToken and rejected wherever a product token is expected. The admin here
// signs in with TOTP, the strictest console path (test/admin-mfa.test.ts).
import { ApiError, CONSOLE_AUDIENCE, productAudience } from '@z-cloudbase/contracts';
import { verifyAccessToken, verifyConsoleToken } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { decodeJwt, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerConsoleClient } from '../src/clients.ts';
import { asSystem } from '../src/system.ts';
import { CookieJar, auth, call, signUp } from './helpers.ts';
import { CONSOLE, consoleLogin, enrollTotp } from './mfa.ts';
import { authorizeWithSession, pkcePair, randomToken, setupClients, ssoToProduct } from './oauth-flow.ts';

async function jwks() {
  return (await call('/api/auth/jwks.json')).json<JSONWebKeySet>();
}

describe('platform_console client', () => {
  let userId: string;
  let token: string;
  /** The admin's identity session (second factor passed at enrollment). */
  const adminJar = new CookieJar();

  beforeAll(async () => {
    await asSystem(() => registerConsoleClient(auth(), new Headers(), [CONSOLE.redirectUri]));
    await setupClients([{ productId: 'product_a', env: 'prod' }]);
    const admin = await signUp(adminJar);
    userId = admin.userId;
    const { secret } = await enrollTotp(adminJar);
    token = (await consoleLogin(admin.email, secret)).access_token;
  });

  it('issues a JWT access token with the console audience and no pid/env claims', () => {
    const claims = decodeJwt(token);
    expect(claims.aud).toContain(CONSOLE_AUDIENCE);
    expect(claims.sub).toBe(userId);
    expect(claims).not.toHaveProperty('pid');
    expect(claims).not.toHaveProperty('env');
    expect(claims).not.toHaveProperty('anon');
  });

  it('is accepted by verifyConsoleToken', async () => {
    const claims = await verifyConsoleToken(token, { issuer: env.ISSUER, jwks: await jwks() });
    expect(claims.sub).toBe(userId);
  });

  it('is rejected by verifyAccessToken for a product audience and for the console audience', async () => {
    for (const audience of [productAudience('product_a.prod'), CONSOLE_AUDIENCE]) {
      const err = await verifyAccessToken(token, { issuer: env.ISSUER, audience, jwks: await jwks() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('invalid_token');
    }
  });

  it('a product access token is rejected by verifyConsoleToken', async () => {
    const jar = new CookieJar();
    await signUp(jar);
    const product = await ssoToProduct(jar, 'product_a');
    const err = await verifyConsoleToken(product.access_token, { issuer: env.ISSUER, jwks: await jwks() }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('invalid_token');
  });

  it('the console client cannot obtain a product audience', async () => {
    const { challenge } = await pkcePair();
    const err = await authorizeWithSession(adminJar, {
      productId: '',
      env: 'prod',
      state: randomToken(),
      nonce: randomToken(),
      challenge,
      client: CONSOLE,
      resource: productAudience('product_a.prod'),
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/invalid_target/);
  });

  it('console sign-in creates no product membership', async () => {
    const n = await env.DB.prepare('SELECT count(*) AS n FROM product_memberships WHERE user_id = ?').bind(userId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
