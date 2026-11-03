import { ApiError, PRODUCT_ID_RE, clientId, isEnvironment, productAudience, type AccessTokenClaims, type Environment } from '@z-cloudbase/contracts';
import { verifyAccessToken } from '@z-cloudbase/security';
import { PlatformError } from './errors.ts';
import type { Oidc } from './oidc.ts';

export interface ExpectedProduct {
  productId: string;
  env: Environment;
}

/**
 * Token verification for product backends. There is no profile call: `GET /v1/me` is a browser
 * endpoint (publishable key + user token); the verified claims already carry `sub`, `pid`, `env`, `anon`.
 */
export function createAuth(oidc: Oidc) {
  return {
    /**
     * Verify an end user's access token for exactly one product environment: signature (issuer
     * JWKS), `typ: at+jwt`, issuer, audience `urn:platform:{productId}.{env}`, expiry and claims.
     * A token minted for any other product fails with `invalid_token`.
     * Note: a JWKS fetch failure also surfaces as `invalid_token` (fail closed).
     */
    async verifyToken(token: string, expected: ExpectedProduct): Promise<AccessTokenClaims> {
      if (!PRODUCT_ID_RE.test(expected.productId) || !isEnvironment(expected.env)) {
        throw new PlatformError('sdk_error', 'verifyToken needs a valid productId and env');
      }
      const { jwks } = await oidc.discover();
      try {
        return await verifyAccessToken(token, {
          issuer: oidc.issuer,
          audience: productAudience(clientId(expected.productId, expected.env)),
          jwks,
        });
      } catch (e) {
        if (e instanceof ApiError) throw new PlatformError(e.code, e.message, { status: e.status, retryable: e.retryable });
        throw e;
      }
    },
  };
}
