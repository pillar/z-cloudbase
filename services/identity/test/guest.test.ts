// Guest entry for products that start anonymously (PRD §4.2 item 4): `GET /guest?authorize=...` signs a
// visitor without a session in anonymously and continues the authorization request; an existing session is
// kept; only this issuer's authorization endpoint is accepted; the route is rate limited per IP.
import { AUTH_RATE_PER_IP_PER_MIN } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, call, signUp } from './helpers.ts';
import { authorizeUrl, exchangeCode, pkcePair, randomToken, setupClients, type TokenResponse } from './oauth-flow.ts';

beforeAll(async () => {
  await setupClients([{ productId: 'guest_game', env: 'prod' }]);
});

const userCount = async () => (await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>())!.n;

/** The SDK's guest navigation: /guest wrapping a full authorization URL of guest_game.prod. */
async function guestEntry(jar: CookieJar, ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
  const { verifier, challenge } = await pkcePair();
  const authorize = `${env.ISSUER}${authorizeUrl({ productId: 'guest_game', env: 'prod', state: randomToken(), nonce: randomToken(), challenge })}`;
  const res = await call(`/guest?${new URLSearchParams({ authorize })}`, { jar, headers: { 'cf-connecting-ip': ip } });
  return { res, verifier };
}

/** Follows the continuation to the product callback and exchanges the code. */
async function finish(jar: CookieJar, res: Response, verifier: string) {
  expect(res.status).toBe(302);
  const next = res.headers.get('location')!;
  expect(next.startsWith('/api/auth/oauth2/authorize?')).toBe(true);
  jar.store(res);
  const cb = await call(next, { jar });
  expect(cb.status).toBe(302);
  const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
  const tokens = await (await exchangeCode('guest_game', 'prod', code, verifier)).json<TokenResponse>();
  return decodeJwt(tokens.access_token);
}

describe('GET /guest', () => {
  it('signs a visitor without a session in as an anonymous guest and returns a code for the product', async () => {
    const before = await userCount();
    const jar = new CookieJar();
    const { res, verifier } = await guestEntry(jar);
    const claims = await finish(jar, res, verifier);
    expect(claims.anon).toBe(true);
    expect(claims.aud).toContain('urn:platform:guest_game.prod');
    expect(await userCount()).toBe(before + 1);
  });

  it('keeps an existing session: a signed-in user is not turned into a guest', async () => {
    const jar = new CookieJar();
    const u = await signUp(jar);
    const before = await userCount();
    const { res, verifier } = await guestEntry(jar);
    const claims = await finish(jar, res, verifier);
    expect(claims.sub).toBe(u.userId);
    expect(claims.anon).toBe(false);
    expect(await userCount()).toBe(before);
  });

  it('only continues to this issuer’s authorization endpoint and creates nothing otherwise', async () => {
    const before = await userCount();
    for (const authorize of [
      'https://evil.example/api/auth/oauth2/authorize?client_id=x',
      `${env.ISSUER}/account`,
      `${env.ISSUER}//evil.example/api/auth/oauth2/authorize`,
      'javascript:alert(1)',
      '',
    ]) {
      const res = await call(`/guest?${new URLSearchParams({ authorize })}`);
      expect(res.status, authorize).toBe(400);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('invalid_request');
    }
    expect(await userCount()).toBe(before);
  });

  it(`is rate limited per IP like sign-up (${AUTH_RATE_PER_IP_PER_MIN} per minute)`, async () => {
    const ip = `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < AUTH_RATE_PER_IP_PER_MIN; i++) expect((await guestEntry(new CookieJar(), ip)).res.status).toBe(302);
    expect((await guestEntry(new CookieJar(), ip)).res.status).toBe(429);
  });
});
