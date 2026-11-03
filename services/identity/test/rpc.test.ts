// IdentityRpc (packages/contracts identity-rpc.ts), exercised through the entrypoint class.
import { ApiError, CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID, productAudience } from '@z-cloudbase/contracts';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { IdentityRpc } from '../src/index.ts';
import { CookieJar, PASSWORD, auditRows, call, seedProduct, signIn, signUp } from './helpers.ts';
import { enrollTotp } from './mfa.ts';
import {
  REDIRECT,
  authorizeWithSession,
  exchangeCode,
  pkcePair,
  randomToken,
  refresh,
  setupClients,
  ssoToProduct,
} from './oauth-flow.ts';

const rpc = () => new IdentityRpc(createExecutionContext(), env);

async function sessionOf(jar: CookieJar) {
  const res = await call('/api/auth/get-session', { jar });
  return res.json<{ user: { id: string } } | null>();
}

describe('IdentityRpc', () => {
  beforeAll(async () => {
    await setupClients([
      { productId: 'product_a', env: 'prod' },
      { productId: 'product_b', env: 'prod' },
    ]);
  });

  it('getJwks returns the public signing keys served at /api/auth/jwks.json', async () => {
    const served = await (await call('/api/auth/jwks.json')).json<{ keys: Array<{ kid: string }> }>();
    const jwks = await rpc().getJwks();
    expect(jwks.keys.map((k) => k.kid)).toEqual(served.keys.map((k) => k.kid));
    expect(jwks.keys.every((k) => !('d' in k))).toBe(true);
  });

  it('upsertProductClient registers a client without any user session, then updates its redirect URIs', async () => {
    await seedProduct('product_rpc');
    const created = await rpc().upsertProductClient({
      productId: 'product_rpc',
      env: 'staging',
      redirectUris: ['https://rpc.example.test/old'],
      type: 'confidential',
    });
    expect(created).toMatchObject({ clientId: 'product_rpc.staging', resource: productAudience('product_rpc.staging') });
    expect(created.clientSecret).toEqual(expect.any(String)); // shown once

    const updated = await rpc().upsertProductClient({
      productId: 'product_rpc',
      env: 'staging',
      redirectUris: ['https://rpc.example.test/new'],
      type: 'confidential',
    });
    expect(updated).toEqual({ clientId: 'product_rpc.staging', resource: productAudience('product_rpc.staging') });

    const row = await env.DB.prepare(`SELECT redirectUris, referenceId, userId FROM oauthClient WHERE clientId = 'product_rpc.staging'`)
      .first<{ redirectUris: string; referenceId: string; userId: string | null }>();
    expect(row!.redirectUris).toContain('https://rpc.example.test/new');
    expect(row!.redirectUris).not.toContain('https://rpc.example.test/old');
    expect(row).toMatchObject({ referenceId: 'platform', userId: null });
    const links = await env.DB.prepare(`SELECT resourceId FROM oauthClientResource WHERE clientId = 'product_rpc.staging'`).all();
    expect(links.results).toEqual([{ resourceId: productAudience('product_rpc.staging') }]);

    // The system principal never leaks into user/session tables.
    const ghost = await env.DB.prepare(`SELECT count(*) AS n FROM "user" WHERE id = 'system'`).first<{ n: number }>();
    expect(ghost!.n).toBe(0);
  });

  it('upsertProductClient uses `native` for loopback dev callbacks and rejects a type change or bad input', async () => {
    await expect(
      rpc().upsertProductClient({ productId: 'product_dev', env: 'dev', redirectUris: ['http://127.0.0.1:5173/cb'], type: 'public' }),
    ).resolves.toMatchObject({ clientId: 'product_dev.dev' });
    const err = await rpc()
      .upsertProductClient({ productId: 'product_dev', env: 'dev', redirectUris: ['http://127.0.0.1:5173/cb'], type: 'confidential' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_request');
    const bad = await rpc()
      .upsertProductClient({ productId: 'Bad Id', env: 'dev', redirectUris: ['https://x.example.test/cb'], type: 'public' })
      .catch((e: unknown) => e);
    expect((bad as ApiError).code).toBe('validation_failed');
  });

  it('revokeUserTokens with productId revokes only that product\'s refresh tokens', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const a = await ssoToProduct(jar, 'product_a');
    const b = await ssoToProduct(jar, 'product_b');

    await rpc().revokeUserTokens({ userId, productId: 'product_a', reason: 'membership revoked' });

    expect((await refresh('product_a', 'prod', a.refresh_token!)).status).toBe(400);
    expect((await refresh('product_b', 'prod', b.refresh_token!)).status).toBe(200);
    expect((await sessionOf(jar))?.user.id).toBe(userId); // identity session kept (SSO for other products)
    expect(await auditRows('auth.tokens_revoked', userId)).toEqual([
      expect.objectContaining({ actor_type: 'system', product_id: 'product_a', metadata: { reason: 'membership revoked', scope: 'product' } }),
    ]);
  });

  it('revokeUserTokens without productId revokes all sessions and refresh tokens', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const a = await ssoToProduct(jar, 'product_a');
    const b = await ssoToProduct(jar, 'product_b');

    await rpc().revokeUserTokens({ userId, reason: 'security' });

    expect((await refresh('product_a', 'prod', a.refresh_token!)).status).toBe(400);
    expect((await refresh('product_b', 'prod', b.refresh_token!)).status).toBe(400);
    expect(await sessionOf(jar)).toBeNull();
  });

  it('deleteUserIdentity revokes everything, deletes credentials and leaves an idempotent tombstone', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    const a = await ssoToProduct(jar, 'product_a');
    // A pending password reset must not survive the deletion.
    await call('/api/auth/request-password-reset', { json: { email } });
    const pendingResets = await env.DB.prepare('SELECT count(*) AS n FROM verification WHERE value = ?').bind(userId).first<{ n: number }>();
    expect(pendingResets!.n).toBe(1);
    // A second factor and an unused export link must not survive either.
    await enrollTotp(jar);
    await env.DB.prepare(`INSERT INTO deletion_requests (id, user_id, kind, scope, status, requested_at, due_at) VALUES ('del_rpc_x', ?, 'export', 'account', 'completed', 0, 0)`)
      .bind(userId).run();
    await env.DB.prepare("INSERT INTO export_links (token_hash, request_id, user_id, created_at, expires_at) VALUES ('h', 'del_rpc_x', ?, 0, ?)")
      .bind(userId, Date.now() + 60_000).run();

    await rpc().deleteUserIdentity({ userId, reason: 'user request' });

    const row = await env.DB.prepare('SELECT email, name, deletedAt FROM "user" WHERE id = ?')
      .bind(userId)
      .first<{ email: string; name: string; deletedAt: string | null }>();
    expect(row!.email).not.toBe(email);
    expect(row!.email).toMatch(/@deleted\.invalid$/);
    expect(row!.name).toBe('');
    expect(row!.deletedAt).not.toBeNull();
    const counts = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM account WHERE userId = ?1) AS accounts, (SELECT count(*) FROM session WHERE userId = ?1) AS sessions,
              (SELECT count(*) FROM oauthRefreshToken WHERE userId = ?1) AS refresh, (SELECT count(*) FROM verification WHERE value = ?1) AS resets,
              (SELECT count(*) FROM twoFactor WHERE userId = ?1) AS totp, (SELECT count(*) FROM export_links WHERE user_id = ?1) AS links,
              (SELECT twoFactorEnabled FROM "user" WHERE id = ?1) AS enabled`,
    )
      .bind(userId)
      .first();
    expect(counts).toEqual({ accounts: 0, sessions: 0, refresh: 0, resets: 0, totp: 0, links: 0, enabled: 0 });
    expect((await refresh('product_a', 'prod', a.refresh_token!)).status).toBe(400);
    expect((await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } })).status).toBe(401);

    // Idempotent: a retried job is a no-op and writes no second audit row.
    await rpc().deleteUserIdentity({ userId, reason: 'retry' });
    expect(await auditRows('auth.identity_deleted', userId)).toHaveLength(1);
    // The address is free again for a new, unrelated account.
    await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: 'New' } });
    const reused = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<{ id: string }>();
    expect(reused!.id).not.toBe(userId);
  });

  it('deleteUserIdentity of an unknown user is not_found', async () => {
    const err = await rpc().deleteUserIdentity({ userId: 'usr_00000000-0000-7000-8000-000000000000', reason: 'x' }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('not_found');
  });

  it('exportUserIdentity returns profile and providers, never hashes or tokens', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    await env.DB.prepare(
      `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES ('pk_exp', 'Laptop', 'PUBLIC-KEY-NOT-EXPORTED', ?, 'CRED-NOT-EXPORTED', 0, 'multiDevice', 1, '2026-11-01T00:00:00.000Z')`,
    ).bind(userId).run();
    const exported = await rpc().exportUserIdentity({ userId });
    expect(JSON.stringify(exported)).not.toMatch(/NOT-EXPORTED/);
    expect(exported).toEqual({
      user_id: userId,
      email,
      email_verified: false,
      name: 'Test',
      is_anonymous: false,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      providers: ['credential'],
      two_factor_enabled: false,
      passkeys: [{ name: 'Laptop', created_at: '2026-11-01T00:00:00.000Z', device_type: 'multiDevice', backed_up: true }],
    });
    const anon = await call('/api/auth/sign-in/anonymous', { json: {} });
    const anonId = (await anon.json<{ user: { id: string } }>()).user.id;
    expect(await rpc().exportUserIdentity({ userId: anonId })).toMatchObject({ email: null, is_anonymous: true, providers: [] });
  });

  it('a product session after revocation needs a fresh authorization (SSO still works)', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    await rpc().revokeUserTokens({ userId, productId: 'product_a', reason: 'test' });
    // The identity session is intact, so the user can authorize product_a again without a password.
    const { challenge, verifier } = await pkcePair();
    const cb = await authorizeWithSession(jar, { productId: 'product_a', env: 'prod', state: randomToken(), nonce: randomToken(), challenge });
    expect(`${cb.origin}${cb.pathname}`).toBe(REDIRECT('product_a'));
    expect((await exchangeCode('product_a', 'prod', cb.searchParams.get('code')!, verifier)).status).toBe(200);
    expect(await signIn(new CookieJar(), email)).toBe(userId);
  });
});
