import {
  ApiError, AccessTokenClaims, CONSOLE_AUDIENCE, ConsoleTokenClaims, JWT_CLOCK_TOLERANCE_S, clientId, productAudience,
  userinfoAudience,
} from '@z-cloudbase/contracts';
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

export const ACCESS_TOKEN_ALGS = ['EdDSA', 'ES256'];

export interface VerifyOptions {
  issuer: string;
  /** Expected `productAudience('{product_id}.{env}')`; a token for any other audience is rejected. */
  audience: string;
  jwks: JSONWebKeySet | JWTVerifyGetKey;
  now?: Date;
}

/**
 * Verify a platform access token: signature, `typ`, issuer, audience, expiry and claim shape;
 * `pid`/`env` must agree with the expected audience, and the only other `aud` member allowed
 * is the issuer's userinfo audience (PRD §4.2 item 4, §19.4).
 */
async function verifyJwt(token: string, opts: VerifyOptions): Promise<{ payload: unknown; aud: string[] }> {
  const keys = typeof opts.jwks === 'function' ? opts.jwks : createLocalJWKSet(opts.jwks);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ACCESS_TOKEN_ALGS,
      clockTolerance: JWT_CLOCK_TOLERANCE_S,
      typ: 'at+jwt',
      ...(opts.now ? { currentDate: opts.now } : {}),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new ApiError('token_expired', 'Access token expired');
    throw new ApiError('invalid_token', 'Access token is invalid');
  }
  const extra = userinfoAudience(opts.issuer);
  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud ?? ''];
  if (aud.some((a) => a !== opts.audience && a !== extra)) {
    throw new ApiError('invalid_token', 'Access token has an unexpected audience');
  }
  return { payload, aud };
}

export async function verifyAccessToken(token: string, opts: VerifyOptions): Promise<AccessTokenClaims> {
  const { payload } = await verifyJwt(token, opts);
  const parsed = AccessTokenClaims.safeParse(payload);
  if (!parsed.success) throw new ApiError('invalid_token', 'Access token claims are malformed');
  const claims = parsed.data;
  if (productAudience(clientId(claims.pid, claims.env)) !== opts.audience) {
    throw new ApiError('invalid_token', 'Access token audience does not match its product');
  }
  return claims;
}

/** Verify a console access token (admin API): audience must be CONSOLE_AUDIENCE. */
export async function verifyConsoleToken(
  token: string,
  opts: Omit<VerifyOptions, 'audience'>,
): Promise<ConsoleTokenClaims> {
  const { payload } = await verifyJwt(token, { ...opts, audience: CONSOLE_AUDIENCE });
  const parsed = ConsoleTokenClaims.safeParse(payload);
  if (!parsed.success) throw new ApiError('invalid_token', 'Access token claims are malformed');
  return parsed.data;
}

/** Extract a bearer token; never accept tokens from query strings (PRD §6.3). */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim());
  return m ? m[1]! : null;
}
