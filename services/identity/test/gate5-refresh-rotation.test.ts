// Gate 5 (PRD §19.1): refresh token rotation; replaying a rotated token revokes the family.
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { productResource } from '../src/auth.ts';
import { CookieJar, auditRows, signUp } from './helpers.ts';
import { loginToProduct, refresh, setupClients, type TokenResponse } from './oauth-flow.ts';

async function refreshOk(productId: string, rt: string) {
  const res = await refresh(productId, 'prod', rt);
  expect(res.status).toBe(200);
  return res.json<TokenResponse>();
}

async function expectRefreshRejected(productId: string, rt: string) {
  const res = await refresh(productId, 'prod', rt);
  expect(res.status).toBe(400);
  expect((await res.json<{ error: string }>()).error).toBe('invalid_grant');
}

describe('gate 5: refresh token rotation and replay detection', () => {
  beforeAll(async () => {
    await setupClients([
      { productId: 'product_a', env: 'prod' },
      { productId: 'product_b', env: 'prod' },
    ]);
  });

  it('rotates on every use and keeps the product audience and claims', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const t0 = await loginToProduct(new CookieJar(), email, 'product_a', 'prod');
    const t1 = await refreshOk('product_a', t0.refresh_token!);
    const t2 = await refreshOk('product_a', t1.refresh_token!);
    expect(new Set([t0.refresh_token, t1.refresh_token, t2.refresh_token]).size).toBe(3);
    const claims = decodeJwt(t2.access_token);
    expect(claims).toMatchObject({ sub: userId, pid: 'product_a', env: 'prod', anon: false });
    expect(claims.aud).toContain(productResource('product_a.prod'));
  });

  it('replaying a rotated refresh token is rejected and revokes the whole family', async () => {
    const { email } = await signUp(new CookieJar());
    const t0 = await loginToProduct(new CookieJar(), email, 'product_a', 'prod');
    const t1 = await refreshOk('product_a', t0.refresh_token!);
    const t2 = await refreshOk('product_a', t1.refresh_token!);

    await expectRefreshRejected('product_a', t0.refresh_token!); // replay of a rotated token
    await expectRefreshRejected('product_a', t2.refresh_token!); // current token of the family is now dead

    const rows = await env.DB.prepare(
      `SELECT count(*) AS n FROM oauthRefreshToken r JOIN "user" u ON u.id = r.userId WHERE u.email = ? AND r.clientId = 'product_a.prod'`,
    )
      .bind(email)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('replay is recorded as a system security event (auth.refresh_token_reuse)', async () => {
    const { email, userId } = await signUp(new CookieJar());
    const t0 = await loginToProduct(new CookieJar(), email, 'product_a', 'prod');
    await refreshOk('product_a', t0.refresh_token!);
    expect(await auditRows('auth.refresh_token_reuse', userId)).toEqual([]); // normal rotation is not an event

    await expectRefreshRejected('product_a', t0.refresh_token!);
    expect(await auditRows('auth.refresh_token_reuse', userId)).toEqual([
      expect.objectContaining({ actor_type: 'system', product_id: 'product_a', env: 'prod', metadata: { client_id: 'product_a.prod' } }),
    ]);
  });

  it('revocation scope: all of the user\'s refresh tokens for that client, not other clients', async () => {
    const { email } = await signUp(new CookieJar());
    const deviceA1 = await loginToProduct(new CookieJar(), email, 'product_a', 'prod');
    const deviceA2 = await loginToProduct(new CookieJar(), email, 'product_a', 'prod');
    const deviceB = await loginToProduct(new CookieJar(), email, 'product_b', 'prod');

    const rotated = await refreshOk('product_a', deviceA1.refresh_token!);
    await expectRefreshRejected('product_a', deviceA1.refresh_token!); // replay

    // Better Auth revokes by (client, user): the user's other product_a device is logged out too.
    await expectRefreshRejected('product_a', rotated.refresh_token!);
    await expectRefreshRejected('product_a', deviceA2.refresh_token!);
    // product_b is untouched.
    await refreshOk('product_b', deviceB.refresh_token!);
  });
});
