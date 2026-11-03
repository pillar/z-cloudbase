import { ACCESS_TOKEN_TTL_S, CONSOLE_AUDIENCE, clientId, newId, newUserId, productAudience, userinfoAudience, type AccessTokenClaims, type Environment } from '@z-cloudbase/contracts';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';

export const TEST_ISSUER = 'http://identity.test';

export interface TestTokenMinter {
  jwks: JSONWebKeySet;
  kid: string;
  /** Mint an access token shaped like the identity worker's (aud array, typ at+jwt); any claim can be overridden. */
  mint(opts: { productId: string; env: Environment; userId?: string } & Partial<AccessTokenClaims>): Promise<string>;
  /** Mint a console (admin API) access token: aud = CONSOLE_AUDIENCE, no pid/env. */
  mintConsole(opts: { userId: string } & Partial<AccessTokenClaims>): Promise<string>;
}

/**
 * Test-only issuer that signs tokens shaped like real platform access tokens, so
 * API-side tests don't depend on the identity worker. Never use outside tests.
 */
export async function createTestTokenMinter(issuer = TEST_ISSUER): Promise<TestTokenMinter> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = newId('kid');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    kid,
    async mint({ productId, env, userId, ...overrides }) {
      const now = Math.floor(Date.now() / 1000);
      const claims: AccessTokenClaims = {
        iss: issuer,
        sub: userId ?? newUserId(),
        aud: [productAudience(clientId(productId, env)), userinfoAudience(issuer)],
        iat: now,
        exp: now + ACCESS_TOKEN_TTL_S,
        jti: newId('jti'),
        sid: newId('ses'),
        pid: productId,
        env,
        anon: false,
        scope: 'openid offline_access',
        ...overrides,
      };
      return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'at+jwt' }).sign(privateKey);
    },
    async mintConsole({ userId, ...overrides }) {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer, sub: userId, aud: [CONSOLE_AUDIENCE, userinfoAudience(issuer)], iat: now,
        exp: now + ACCESS_TOKEN_TTL_S, jti: newId('jti'), sid: newId('ses'), scope: 'openid offline_access',
        ...overrides,
      };
      return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'at+jwt' }).sign(privateKey);
    },
  };
}
