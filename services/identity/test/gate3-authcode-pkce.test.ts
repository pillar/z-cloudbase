// Gate 3 (PRD §19.1): Authorization Code + PKCE over HTTP, state and OIDC nonce round-trip,
// wrong code_verifier and reused code rejected.
import { env } from 'cloudflare:workers';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, call, signUp } from './helpers.ts';
import { REDIRECT, authorizeWithLogin, exchangeCode, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';

export async function fetchJwks() {
  const res = await call('/api/auth/jwks.json');
  if (res.status !== 200) throw new Error(`jwks: ${res.status}`);
  return res.json<JSONWebKeySet>();
}

describe('gate 3: authorization code + PKCE', () => {
  beforeAll(async () => {
    await setupClients([{ productId: 'product_a', env: 'prod' }]);
  });

  it('serves OIDC discovery for the issuer', async () => {
    const res = await call('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    const meta = await res.json<Record<string, unknown>>();
    expect(meta.issuer).toBe(env.ISSUER);
    expect(meta.jwks_uri).toBe(`${env.ISSUER}/api/auth/jwks.json`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.id_token_signing_alg_values_supported).toContain('EdDSA');
  });

  it('authorize -> login -> code -> token, with state echoed and id_token nonce bound', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(new CookieJar());
    const { verifier, challenge } = await pkcePair();
    const state = randomToken();
    const nonce = randomToken();

    const cb = await authorizeWithLogin(jar, email, { productId: 'product_a', env: 'prod', state, nonce, challenge });
    expect(`${cb.origin}${cb.pathname}`).toBe(REDIRECT('product_a'));
    expect(cb.searchParams.get('state')).toBe(state);
    expect(cb.searchParams.get('iss')).toBe(env.ISSUER); // RFC 9207 mix-up defence
    const code = cb.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const res = await exchangeCode('product_a', 'prod', code, verifier);
    expect(res.status).toBe(200);
    const tokens = await res.json<TokenResponse>();
    expect(tokens.refresh_token).toBeTruthy();

    const { payload, protectedHeader } = await jwtVerify(tokens.id_token!, createLocalJWKSet(await fetchJwks()), {
      issuer: env.ISSUER,
      audience: 'product_a.prod',
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.nonce).toBe(nonce);
    expect(payload.sub).toBe(userId);
  });

  it('rejects a wrong code_verifier and burns the code', async () => {
    const jar = new CookieJar();
    const { email } = await signUp(new CookieJar());
    const { verifier, challenge } = await pkcePair();
    const cb = await authorizeWithLogin(jar, email, { productId: 'product_a', env: 'prod', state: 's', nonce: 'n', challenge });
    const code = cb.searchParams.get('code')!;
    const res = await exchangeCode('product_a', 'prod', code, (await pkcePair()).verifier);
    // RFC 6749 §5.2 / RFC 7636 §4.6: a failed PKCE check is 400 `invalid_grant`
    // (Better Auth up to 1.7.7 answered 401 `invalid_request`).
    expect(res.status).toBe(400);
    const err = await res.json<{ error: string; access_token?: string }>();
    expect(err.error).toBe('invalid_grant');
    expect(err.access_token).toBeUndefined();
    // The code was consumed by the failed attempt; the right verifier cannot redeem it now.
    const retry = await exchangeCode('product_a', 'prod', code, verifier);
    expect(retry.status).toBe(400);
    expect((await retry.json<{ error: string }>()).error).toBe('invalid_grant');
  });

  it('rejects a reused authorization code', async () => {
    const jar = new CookieJar();
    const { email } = await signUp(new CookieJar());
    const { verifier, challenge } = await pkcePair();
    const cb = await authorizeWithLogin(jar, email, { productId: 'product_a', env: 'prod', state: 's', nonce: 'n', challenge });
    const code = cb.searchParams.get('code')!;
    expect((await exchangeCode('product_a', 'prod', code, verifier)).status).toBe(200);
    const replay = await exchangeCode('product_a', 'prod', code, verifier);
    expect(replay.status).toBe(400);
    expect((await replay.json<{ error: string }>()).error).toBe('invalid_grant');
  });

  it('rejects an unregistered redirect_uri without redirecting to it', async () => {
    const { challenge } = await pkcePair();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: 'product_a.prod',
      redirect_uri: 'https://evil.example.test/callback',
      scope: 'openid',
      state: 's',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await call(`/api/auth/oauth2/authorize?${q}`);
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('evil.example.test');
  });
});
