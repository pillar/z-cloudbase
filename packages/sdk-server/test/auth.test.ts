import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createServerClient } from '../src/index.ts';
import { ENDPOINT, ISSUER, SK, apiError, baseConfig, createFakeIdp, fakeFetch, json } from './helpers.ts';

const A = { productId: 'product_a', env: 'dev' } as const;

async function setup() {
  const idp = await createFakeIdp();
  const api = fakeFetch((r) => (r.url.startsWith(ENDPOINT) ? json({ user_id: 'usr_test' }) : idp.handler(r)));
  const server = createServerClient(baseConfig({ fetch: api.fetch }));
  return { idp, api, server };
}

describe('auth.verifyToken', () => {
  it('accepts a token minted for the expected product and returns its claims', async () => {
    const { idp, server } = await setup();
    const token = await idp.minter.mint({ productId: 'product_a', env: 'dev', userId: 'usr_alice' });
    const claims = await server.auth.verifyToken(token, A);
    expect(claims).toMatchObject({ sub: 'usr_alice', pid: 'product_a', env: 'dev', anon: false });
  });

  it('rejects a token minted for another product (cross-product isolation)', async () => {
    const { idp, server } = await setup();
    const tokenB = await idp.minter.mint({ productId: 'product_b', env: 'dev' });
    await expect(server.auth.verifyToken(tokenB, A)).rejects.toMatchObject({ code: 'invalid_token', status: 401 });
    // and the reverse direction
    const tokenA = await idp.minter.mint({ productId: 'product_a', env: 'dev' });
    await expect(server.auth.verifyToken(tokenA, { productId: 'product_b', env: 'dev' })).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects a token from another environment of the same product', async () => {
    const { idp, server } = await setup();
    const prod = await idp.minter.mint({ productId: 'product_a', env: 'prod' });
    await expect(server.auth.verifyToken(prod, A)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects a console token (different audience)', async () => {
    const { idp, server } = await setup();
    const token = await idp.minter.mintConsole({ userId: 'usr_admin' });
    await expect(server.auth.verifyToken(token, A)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('reports an expired token as token_expired', async () => {
    const { idp, server } = await setup();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await idp.minter.mint({ productId: 'product_a', env: 'dev', iat: past - 900, exp: past });
    await expect(server.auth.verifyToken(token, A)).rejects.toMatchObject({ code: 'token_expired' });
  });

  it('rejects tokens with a foreign issuer, an unknown signing key, or a non-at+jwt type', async () => {
    const { idp, server } = await setup();
    const foreignIssuer = await idp.minter.mint({ productId: 'product_a', env: 'dev', iss: 'http://evil.test' });
    await expect(server.auth.verifyToken(foreignIssuer, A)).rejects.toMatchObject({ code: 'invalid_token' });

    const stranger = await createFakeIdp(); // a different signing key the issuer never published
    const forged = await stranger.minter.mint({ productId: 'product_a', env: 'dev' });
    await expect(server.auth.verifyToken(forged, A)).rejects.toMatchObject({ code: 'invalid_token' });

    // an id_token-shaped JWT signed by a key the issuer does publish, but typ is not at+jwt
    const now = Math.floor(Date.now() / 1000);
    const idLike = await new SignJWT({ pid: 'product_a', env: 'dev', sid: 's', jti: 'j', anon: false, scope: 'openid' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'id1', typ: 'JWT' })
      .setIssuer(ISSUER).setSubject('usr_test').setAudience(['urn:platform:product_a.dev'])
      .setIssuedAt(now).setExpirationTime(now + 300).sign(idp.idKey.privateKey);
    await expect(server.auth.verifyToken(idLike, A)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects garbage and unsigned input', async () => {
    const { server } = await setup();
    await expect(server.auth.verifyToken('not-a-jwt', A)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(server.auth.verifyToken('', A)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('refuses to verify against a malformed product reference', async () => {
    const { idp, server } = await setup();
    const token = await idp.minter.mint({ productId: 'product_a', env: 'dev' });
    await expect(server.auth.verifyToken(token, { productId: 'Not Valid', env: 'dev' })).rejects.toMatchObject({ code: 'sdk_error' });
    await expect(server.auth.verifyToken(token, { productId: 'product_a', env: 'qa' as 'dev' })).rejects.toMatchObject({ code: 'sdk_error' });
  });

  it('fetches discovery and the JWKS once, not per token', async () => {
    const { idp, server } = await setup();
    for (let i = 0; i < 5; i++) {
      await server.auth.verifyToken(await idp.minter.mint({ productId: 'product_a', env: 'dev' }), A);
    }
    expect(idp.discoveryCalls).toBe(1);
    expect(idp.jwksCalls).toBe(1);
  });

  it('retries discovery after a failure instead of caching it', async () => {
    const idp = await createFakeIdp();
    let down = true;
    const api = fakeFetch((r) => (down ? Promise.reject(new TypeError('offline')) : idp.handler(r)));
    const server = createServerClient(baseConfig({ fetch: api.fetch }));
    const token = await idp.minter.mint({ productId: 'product_a', env: 'dev' });
    await expect(server.auth.verifyToken(token, A)).rejects.toMatchObject({ code: 'network_error', retryable: true });
    down = false;
    await expect(server.auth.verifyToken(token, A)).resolves.toMatchObject({ pid: 'product_a' });
  });
});

describe('API errors', () => {
  it('has no auth.getUser: GET /v1/me only accepts publishable keys, so a service key could never call it', async () => {
    const { server } = await setup();
    expect('getUser' in server.auth).toBe(false);
  });

  it('surfaces API errors with code, request id and retryable, without retrying a 403', async () => {
    const api = fakeFetch(() => apiError('forbidden_product', 403));
    const server = createServerClient(baseConfig({ fetch: api.fetch }));
    await expect(server.storage.getDownloadUrl('obj_x')).rejects.toMatchObject({ code: 'forbidden_product', requestId: 'req_test', retryable: false });
    expect(api.calls).toHaveLength(1);
  });

  it('retries a 503 marked retryable', async () => {
    let n = 0;
    const api = fakeFetch(() => (n++ === 0 ? apiError('unavailable', 503, true) : json({ url: 'u', expires_at: 'e' })));
    const server = createServerClient(baseConfig({ fetch: api.fetch, retryBaseMs: 1 }));
    await expect(server.storage.getDownloadUrl('obj_x')).resolves.toEqual({ url: 'u', expires_at: 'e' });
    expect(api.calls).toHaveLength(2);
  });
});

describe('configuration', () => {
  it('rejects a publishable key where a service key is required', () => {
    expect(() => createServerClient(baseConfig({ serviceKey: `pk_dev_${'a'.repeat(33)}` }))).toThrow(/sk_/);
  });
});
