// Admin API, PRD §21.5: ban / unban (owner only, never team members), impersonation requests (owner with
// TOTP; never team members, banned users or oneself), the per-environment user export (users:read,
// cross-product isolation, emails only on request, CSV formula neutralisation), and the effect of a ban
// on product API calls with a still-valid access token.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, auditRows, dbValue, errorCode, initApp, makeWorld, seedUser, type Json, type World } from './admin-helpers.ts';
import { minter, seedMembership } from './helpers.ts';

const rpc = vi.hoisted(() => ({ upsertProductClient: vi.fn(), revokeUserTokens: vi.fn(), setUserBan: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));

let w: World;
const U = { alice: 'usr_ua_alice', bob: 'usr_ua_bob', guest: 'usr_ua_guest', evil: 'usr_ua_evil', gone: 'usr_ua_gone' };

async function seenIn(userId: string, productEnvId: string, at = Date.now()) {
  await env.DB.prepare('INSERT OR IGNORE INTO product_env_users (product_env_id, user_id, first_seen_at) VALUES (?, ?, ?)').bind(productEnvId, userId, at).run();
}

beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('ua');
  await seedUser(U.alice, 'alice@ua.example', 'Alice');
  await seedUser(U.bob, 'bob@ua.example', 'Bob');
  await seedUser(U.evil, '=HYPERLINK("http://x")@ua.example', 'Evil');
  await seedUser(U.gone, 'gone@ua.example');
  await env.DB.prepare(`UPDATE "user" SET deletedAt = ? WHERE id = ?`).bind(new Date().toISOString(), U.gone).run();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous) VALUES (?, '', ?, 0, ?, ?, 1)`)
    .bind(U.guest, 'temp-guest@anon.invalid', now, now).run();
  await env.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('acc_1', ?, 'credential', ?, ?, ?), ('acc_2', 'g1', 'google', ?, ?, ?)`)
    .bind(U.alice, U.alice, now, now, U.alice, now, now).run();
  for (const u of [U.alice, U.guest, U.evil, U.gone]) {
    await seedMembership(u, w.a);
    await seenIn(u, w.envs.a.prod);
  }
  await seedMembership(U.bob, w.b);
  await seenIn(U.bob, w.envs.b.prod);
  // The owner has TOTP (impersonation prerequisite).
  await seedUser(w.users.owner, 'owner@ua.example');
  await env.DB.prepare('UPDATE "user" SET twoFactorEnabled = 1 WHERE id = ?').bind(w.users.owner).run();
});
beforeEach(() => {
  rpc.setUserBan.mockReset().mockImplementation(async (i: Json) => ({
    changed: true, banned: i.ban !== null, expires_at: i.ban?.expiresAt ?? null, reason: i.ban?.reason ?? null,
  }));
});

describe('ban / unban', () => {
  it('owner bans with reason and optional expiry through the identity worker', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const res = await api(w.tok.owner, 'POST', `/users/${U.alice}/ban`, { reason: 'chargeback fraud', expires_at: until });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: U.alice, banned: true, expires_at: until, reason: 'chargeback fraud' });
    expect(rpc.setUserBan).toHaveBeenCalledWith(expect.objectContaining({
      userId: U.alice, actorId: w.users.owner, ban: { reason: 'chargeback fraud', expiresAt: until }, requestId: expect.stringMatching(/^req_/),
    }));
    const un = await api(w.tok.owner, 'DELETE', `/users/${U.alice}/ban`);
    expect(un.status).toBe(200);
    expect(rpc.setUserBan).toHaveBeenLastCalledWith(expect.objectContaining({ userId: U.alice, ban: null }));
  });

  it('is owner-only, refuses team members, deleted users and bad expiry', async () => {
    for (const who of ['operator', 'adminA', 'devA', 'adminB'] as const) {
      expect(await errorCode(await api(w.tok[who], 'POST', `/users/${U.alice}/ban`, { reason: 'x' }))).toBe('forbidden');
      expect(await errorCode(await api(w.tok[who], 'DELETE', `/users/${U.alice}/ban`))).toBe('forbidden');
    }
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${w.users.adminA}/ban`, { reason: 'x' }))).toBe('not_found'); // not a user row
    await seedUser(w.users.operator, 'op@ua.example');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${w.users.operator}/ban`, { reason: 'x' }))).toBe('conflict');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.gone}/ban`, { reason: 'x' }))).toBe('not_found');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.alice}/ban`, { reason: '' }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.alice}/ban`, { reason: 'x', expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe('validation_failed');
    expect(rpc.setUserBan).not.toHaveBeenCalled();
  });

  it('a banned user cannot be added to the team; lookup shows the ban, the reason only to owners', async () => {
    await env.DB.prepare('UPDATE "user" SET banned = 1, banReason = ?, banExpires = NULL WHERE id = ?').bind('spam ring', U.bob).run();
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: U.bob, role: 'product_developer', product_id: w.b }))).toBe('conflict');
    const owner = (await (await api(w.tok.owner, 'GET', `/users?user_id=${U.bob}`)).json()) as Json;
    expect(owner.ban).toEqual({ banned: true, expires_at: null, reason: 'spam ring' });
    const adminB = (await (await api(w.tok.adminB, 'GET', `/users?user_id=${U.bob}`)).json()) as Json;
    expect(adminB.ban).toEqual({ banned: true, expires_at: null });
    await env.DB.prepare('UPDATE "user" SET banned = 0, banReason = NULL WHERE id = ?').bind(U.bob).run();
  });
});

describe('impersonation requests', () => {
  it('owner with TOTP gets an identity-domain confirmation URL; the request is pending and audited', async () => {
    const res = await api(w.tok.owner, 'POST', `/users/${U.alice}/impersonations`, { reason: 'support ticket 1234' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body.url).toBe(`${env.ISSUER}/impersonation/${body.id}`);
    expect(await dbValue('SELECT actor_id, target_id, status, reason FROM impersonations WHERE id = ?', body.id)).toEqual({
      actor_id: w.users.owner, target_id: U.alice, status: 'pending', reason: 'support ticket 1234',
    });
    const audit = (await auditRows('user.impersonation.request')).find((r) => r.target_id === U.alice)!;
    expect(JSON.parse(audit.metadata)).toEqual({ impersonation_id: body.id, reason: 'support ticket 1234' });
    // A newer request supersedes the unconfirmed one.
    const again = (await (await api(w.tok.owner, 'POST', `/users/${U.alice}/impersonations`, { reason: 'support ticket 1235' })).json()) as Json;
    expect((await dbValue<Json>('SELECT status FROM impersonations WHERE id = ?', body.id))!.status).toBe('cancelled');
    expect((await dbValue<Json>('SELECT status FROM impersonations WHERE id = ?', again.id))!.status).toBe('pending');
  });

  it('refuses non-owners, owners without TOTP, short reasons, team members, banned users and oneself', async () => {
    for (const who of ['operator', 'adminA', 'devA'] as const) {
      expect(await errorCode(await api(w.tok[who], 'POST', `/users/${U.alice}/impersonations`, { reason: 'support ticket 1234' }))).toBe('forbidden');
    }
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.alice}/impersonations`, { reason: 'short' }))).toBe('validation_failed');
    await seedUser(w.users.adminA, 'admina@ua.example');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${w.users.adminA}/impersonations`, { reason: 'support ticket 1234' }))).toBe('conflict');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${w.users.owner}/impersonations`, { reason: 'support ticket 1234' }))).toBe('conflict');
    await env.DB.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').bind(U.evil).run();
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.evil}/impersonations`, { reason: 'support ticket 1234' }))).toBe('conflict');
    await env.DB.prepare('UPDATE "user" SET banned = 0 WHERE id = ?').bind(U.evil).run();
    expect(await errorCode(await api(w.tok.owner, 'POST', `/users/${U.gone}/impersonations`, { reason: 'support ticket 1234' }))).toBe('not_found');

    await env.DB.prepare('UPDATE "user" SET twoFactorEnabled = 0 WHERE id = ?').bind(w.users.owner).run();
    const res = await api(w.tok.owner, 'POST', `/users/${U.alice}/impersonations`, { reason: 'support ticket 1234' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.details).toEqual({ reason: 'mfa_required' });
    await env.DB.prepare('UPDATE "user" SET twoFactorEnabled = 1 WHERE id = ?').bind(w.users.owner).run();
  });
});

describe('user export (CSV)', () => {
  const csv = async (tok: string, path: string) => {
    const res = await api(tok, 'GET', path);
    return { res, rows: (await res.text()).trim().split('\r\n').map((l) => l.split(',')) };
  };

  it('exports the users of one product environment, without email unless asked, excluding deleted users', async () => {
    const { res, rows } = await csv(w.tok.adminA, `/products/${w.a}/environments/prod/users/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(rows[0]).toEqual(['user_id', 'is_anonymous', 'account_created_at', 'env_first_seen_at', 'membership_status', 'product_joined_at', 'product_last_seen_at', 'providers', 'banned']);
    const ids = rows.slice(1).map((r) => r[0]);
    expect(ids).toEqual([U.alice, U.evil, U.guest].sort());
    const alice = rows.find((r) => r[0] === U.alice)!;
    expect(alice[1]).toBe('false');
    expect(alice[4]).toBe('active');
    expect(alice[7]).toBe('credential;google');
    expect(rows.flat().join()).not.toContain('@');
    const audit = (await auditRows('user.export', w.a)).at(-1)!;
    expect(JSON.parse(audit.metadata)).toMatchObject({ rows: 3, include_email: false, truncated: false });
  });

  it('includes emails on request (none for guests) and neutralises formula-looking cells', async () => {
    const res = await api(w.tok.owner, 'GET', `/products/${w.a}/environments/prod/users/export?include_email=true`);
    const text = await res.text();
    expect(text.split('\r\n')[0]!.endsWith(',email')).toBe(true);
    expect(text).toContain('alice@ua.example');
    expect(text).not.toContain('temp-guest@anon.invalid');
    expect(text).toContain(`"'=HYPERLINK(""http://x"")@ua.example"`);
  });

  it('is scoped: other products and environments are refused or empty; developers and operators cannot export', async () => {
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/environments/prod/users/export`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'GET', `/products/${w.a}/environments/dev/users/export`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.operator, 'GET', `/products/${w.a}/environments/prod/users/export`))).toBe('forbidden');
    const { rows } = await csv(w.tok.adminA, `/products/${w.a}/environments/dev/users/export`);
    expect(rows).toHaveLength(1);
    const b = await csv(w.tok.adminB, `/products/${w.b}/environments/prod/users/export`);
    expect(b.rows.slice(1).map((r) => r[0])).toEqual([U.bob]);
  });
});

describe('a ban stops access tokens issued before it', () => {
  it('product API calls answer 403 user_banned', async () => {
    const m = await minter();
    const token = await m.mint({ productId: w.a, env: 'prod', userId: U.alice });
    const key = (await dbValue<Json>('SELECT publishable_key FROM product_environments WHERE id = ?', w.envs.a.prod))!.publishable_key;
    const app = (await import('../src/index.ts')).default;
    const me = async () => app.request('/v1/me', { headers: { 'X-Platform-Key': key, Authorization: `Bearer ${token}` } }, env);
    expect((await me()).status).toBe(200);
    await env.DB.prepare('UPDATE "user" SET banned = 1, banExpires = ? WHERE id = ?').bind(new Date(Date.now() + 60_000).toISOString(), U.alice).run();
    const res = await me();
    expect([res.status, await errorCode(res)]).toEqual([403, 'user_banned']);
    // An expired ban no longer applies.
    await env.DB.prepare('UPDATE "user" SET banExpires = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), U.alice).run();
    expect((await me()).status).toBe(200);
    await env.DB.prepare('UPDATE "user" SET banned = 0, banExpires = NULL WHERE id = ?').bind(U.alice).run();
  });
});
