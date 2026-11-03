import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { identity } from './identity.ts';

const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;
let cached: { set: JSONWebKeySet; fetchedAt: number } | null = null;

async function loadJwks(env: Env, force: boolean): Promise<JSONWebKeySet> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < (force ? JWKS_MIN_REFRESH_MS : JWKS_TTL_MS)) return cached.set;
  const set = (await identity(env).getJwks()) as JSONWebKeySet;
  cached = { set, fetchedAt: now };
  return set;
}

/**
 * JWKS resolver with a 5-minute cache. An unknown `kid` (key rotation) forces a refetch,
 * rate-limited to once per 30s so bogus kids cannot hammer the identity worker.
 */
export function jwksResolver(env: Env): JWTVerifyGetKey {
  return async (header, token) => {
    let set = await loadJwks(env, false);
    if (!set.keys.some((k) => k.kid === header.kid)) set = await loadJwks(env, true);
    return createLocalJWKSet(set)(header, token);
  };
}
