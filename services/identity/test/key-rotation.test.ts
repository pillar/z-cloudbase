// Signing-key rotation (PRD §4.2 item 7, §19.4): a new kid signs new tokens once the current key
// reaches its rotation time; the retired kid stays in the JWKS for at least access-token TTL +
// 30 minutes, so tokens it signed keep verifying until they expire.
import { ACCESS_TOKEN_TTL_S, productAudience } from '@z-cloudbase/contracts';
import { verifyAccessToken } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { decodeProtectedHeader, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNING_KEY_GRACE_S, SIGNING_KEY_ROTATION_S } from '../src/auth.ts';
import { CookieJar, call, signUp } from './helpers.ts';
import { setupClients, ssoToProduct } from './oauth-flow.ts';

const AUDIENCE = productAudience('product_a.prod');

async function jwks() {
  return (await call('/api/auth/jwks.json')).json<JSONWebKeySet>();
}

/** Move a key's rotation time (`expiresAt`) to `secondsAgo` in the past, in the engine's storage format. */
async function retireKey(kid: string, secondsAgo: number) {
  const row = await env.DB.prepare('SELECT expiresAt FROM jwks WHERE id = ?').bind(kid).first<{ expiresAt: string | number }>();
  const at = new Date(Date.now() - secondsAgo * 1000);
  await env.DB.prepare('UPDATE jwks SET expiresAt = ? WHERE id = ?')
    .bind(typeof row!.expiresAt === 'number' ? at.getTime() : at.toISOString(), kid)
    .run();
}

describe('signing key rotation', () => {
  let jar: CookieJar;

  beforeAll(async () => {
    await setupClients([{ productId: 'product_a', env: 'prod' }]);
    jar = new CookieJar();
    await signUp(jar);
  });

  it('keeps retired keys for at least access-token TTL + 30 minutes (configuration)', () => {
    expect(SIGNING_KEY_GRACE_S).toBeGreaterThanOrEqual(ACCESS_TOKEN_TTL_S + 30 * 60);
    expect(SIGNING_KEY_ROTATION_S).toBeGreaterThan(SIGNING_KEY_GRACE_S);
  });

  it('every signing key carries a rotation time', async () => {
    await ssoToProduct(jar, 'product_a');
    const rows = await env.DB.prepare('SELECT createdAt, expiresAt FROM jwks').all<{ createdAt: string; expiresAt: string | null }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      expect(r.expiresAt).not.toBeNull();
      const lifetime = (new Date(r.expiresAt!).getTime() - new Date(r.createdAt).getTime()) / 1000;
      expect(Math.abs(lifetime - SIGNING_KEY_ROTATION_S)).toBeLessThan(60);
    }
  });

  it('after rotation new tokens use a new kid and tokens of the old kid verify through the grace period', async () => {
    const before = await ssoToProduct(jar, 'product_a');
    const oldKid = decodeProtectedHeader(before.access_token).kid!;

    await retireKey(oldKid, 1); // the rotation time has just passed
    const after = await ssoToProduct(jar, 'product_a');
    const newKid = decodeProtectedHeader(after.access_token).kid!;
    expect(newKid).not.toBe(oldKid);

    const served = await jwks();
    expect(served.keys.map((k) => k.kid)).toEqual(expect.arrayContaining([oldKid, newKid]));
    for (const token of [before.access_token, after.access_token]) {
      const claims = await verifyAccessToken(token, { issuer: env.ISSUER, audience: AUDIENCE, jwks: served });
      expect(claims.pid).toBe('product_a');
    }

    // Still published just before the PRD minimum (TTL + 30 min) has elapsed since retirement.
    await retireKey(oldKid, ACCESS_TOKEN_TTL_S + 30 * 60 - 60);
    expect((await jwks()).keys.map((k) => k.kid)).toContain(oldKid);
    await verifyAccessToken(before.access_token, { issuer: env.ISSUER, audience: AUDIENCE, jwks: await jwks() });

    // Dropped once the grace period is over; the new key keeps signing.
    await retireKey(oldKid, SIGNING_KEY_GRACE_S + 60);
    expect((await jwks()).keys.map((k) => k.kid)).not.toContain(oldKid);
    const later = await ssoToProduct(jar, 'product_a');
    expect(decodeProtectedHeader(later.access_token).kid).toBe(newKid);
  });
});
