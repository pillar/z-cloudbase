// Gate 2 (PRD §19.1): access token for a specific client, audience-bound, EdDSA + kid,
// served JWKS, A's token rejected for B.
import { ACCESS_TOKEN_TTL_S, ApiError, userinfoAudience } from '@z-cloudbase/contracts';
import { verifyAccessToken } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { decodeJwt, decodeProtectedHeader, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { productResource } from '../src/auth.ts';
import { CookieJar, call, signUp } from './helpers.ts';
import { authorizeWithLogin, exchangeCode, loginToProduct, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';

async function fetchJwks() {
  const res = await call('/api/auth/jwks.json');
  expect(res.status).toBe(200);
  return res.json<JSONWebKeySet>();
}

const USERINFO_AUD = userinfoAudience(env.ISSUER);

describe('gate 2: audience-bound access tokens', () => {
  let tokenA: string;
  let userId: string;

  beforeAll(async () => {
    await setupClients([
      { productId: 'product_a', env: 'prod' },
      { productId: 'product_b', env: 'prod' },
    ]);
    const signed = await signUp(new CookieJar());
    userId = signed.userId;
    tokenA = (await loginToProduct(new CookieJar(), signed.email, 'product_a', 'prod')).access_token;
  });

  it('is an EdDSA JWT with a kid published in the served JWKS', async () => {
    const header = decodeProtectedHeader(tokenA);
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('at+jwt');
    const jwks = await fetchJwks();
    expect(jwks.keys.map((k) => k.kid)).toContain(header.kid);
    expect(jwks.keys.every((k) => !('d' in k))).toBe(true); // public keys only
  });

  it('carries the PRD §19.4 claims with a 15 minute lifetime and no PII', () => {
    const claims = decodeJwt(tokenA);
    expect(claims).toMatchObject({ iss: env.ISSUER, sub: userId, pid: 'product_a', env: 'prod', anon: false });
    expect(claims.aud).toEqual([productResource('product_a.prod'), USERINFO_AUD]);
    expect(claims.exp! - claims.iat!).toBe(ACCESS_TOKEN_TTL_S);
    expect(typeof claims.jti).toBe('string');
    expect(typeof claims.sid).toBe('string');
    expect(claims.scope).toBe('openid offline_access');
    expect(claims).not.toHaveProperty('email');
  });

  it('is accepted by @z-cloudbase/security for product_a.prod and rejected for product_b.prod', async () => {
    const jwks = await fetchJwks();
    const claims = await verifyAccessToken(tokenA, { issuer: env.ISSUER, audience: productResource('product_a.prod'), jwks });
    expect(claims.sub).toBe(userId);
    for (const audience of [productResource('product_b.prod'), productResource('product_a.dev'), 'product_a.prod']) {
      const err = await verifyAccessToken(tokenA, { issuer: env.ISSUER, audience, jwks }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('invalid_token');
    }
  });

  it("refuses to mint product_b's audience for the product_a client", async () => {
    const { email } = await signUp(new CookieJar());
    const { challenge } = await pkcePair();
    const err = await authorizeWithLogin(new CookieJar(), email, {
      productId: 'product_a',
      env: 'prod',
      state: randomToken(),
      nonce: randomToken(),
      challenge,
      resource: productResource('product_b.prod'),
    }).catch((e: Error) => e);
    // Rejected at /authorize, before login: `invalid_target` (client not linked to that resource).
    expect(String(err)).toMatch(/invalid_target/);
  });

  it('falls back to an opaque access token when the client omits `resource` (fails closed at the API)', async () => {
    const { email } = await signUp(new CookieJar());
    const { verifier, challenge } = await pkcePair();
    const cb = await authorizeWithLogin(new CookieJar(), email, {
      productId: 'product_a',
      env: 'prod',
      state: randomToken(),
      nonce: randomToken(),
      challenge,
      resource: null,
    });
    const res = await exchangeCode('product_a', 'prod', cb.searchParams.get('code')!, verifier);
    const tokens = await res.json<TokenResponse>();
    expect(tokens.access_token.split('.')).toHaveLength(1); // not a JWT
  });
});
