// Admin API: team management, user lookup, memberships and deletion-request visibility.
import { newId } from '@z-cloudbase/contracts';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, auditRows, dbValue, errorCode, initApp, makeWorld, seedUser, type Json, type World } from './admin-helpers.ts';
import { minter, seedMembership } from './helpers.ts';

const rpc = vi.hoisted(() => ({ upsertProductClient: vi.fn(), revokeUserTokens: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));

let w: World;
const U = { alice: 'usr_usr_alice', bob: 'usr_usr_bob', carol: 'usr_usr_carol', dave: 'usr_usr_dave' };
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('usr');
  await seedUser(U.alice, 'alice@example.com', 'Alice');
  await seedUser(U.bob, 'Bob@Example.com', 'Bob');
  await seedUser(U.carol, 'carol@example.com', 'Carol');
  await seedUser(U.dave, 'dave@example.com', 'Dave');
  await seedMembership(U.alice, w.a);
  await seedMembership(U.alice, w.b);
  await seedMembership(U.bob, w.b);
  await seedMembership(U.dave, w.a);
  const now = Date.now();
  for (const [uid, kind, scope, pid] of [[U.alice, 'delete', 'account', null], [U.alice, 'export', 'product', w.a], [U.alice, 'delete', 'product', w.b]] as const) {
    await env.DB.prepare(
      `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(newId('del'), uid, kind, scope, pid, now, now + 1000).run();
  }
});
beforeEach(() => {
  rpc.revokeUserTokens.mockReset().mockResolvedValue(undefined);
});

describe('team', () => {
  it('lets the owner grant platform roles and product admins grant roles within their own product', async () => {
    const op = await api(w.tok.owner, 'POST', '/team', { user_id: U.carol, role: 'operator' });
    expect(op.status).toBe(201);
    const dev = await api(w.tok.adminA, 'POST', '/team', { user_id: U.carol, role: 'product_developer', product_id: w.a });
    expect(dev.status).toBe(201);
    const devId = ((await dev.json()) as Json).id;
    expect(await dbValue('SELECT role, product_id, created_by FROM team_members WHERE id = ?', devId)).toEqual({
      role: 'product_developer', product_id: w.a, created_by: w.users.adminA,
    });
    expect((await auditRows('team.add')).length).toBeGreaterThanOrEqual(2);

    const listed = ((await (await api(w.tok.adminA, 'GET', `/products/${w.a}/team`)).json()) as Json).members.map((m: Json) => m.id);
    expect(listed).toContain(devId);
  });

  it('forbids product admins from granting platform roles or roles on other products', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'POST', '/team', { user_id: U.bob, role: 'owner' }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'POST', '/team', { user_id: U.bob, role: 'operator' }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'POST', '/team', { user_id: U.bob, role: 'product_admin', product_id: w.b }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'POST', '/team', { user_id: U.bob, role: 'product_developer', product_id: w.a }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.operator, 'POST', '/team', { user_id: U.bob, role: 'product_developer', product_id: w.a }))).toBe('forbidden');
    expect(await dbValue('SELECT 1 AS x FROM team_members WHERE user_id = ?', U.bob)).toBeNull();
  });

  it('validates role/product combinations, the target user and duplicates', async () => {
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: U.bob, role: 'owner', product_id: w.a }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: U.bob, role: 'product_admin' }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: 'bob', role: 'operator' }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: 'usr_ghost', role: 'operator' }))).toBe('not_found');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: U.bob, role: 'product_admin', product_id: 'usr_nope' }))).toBe('not_found');
    expect(await errorCode(await api(w.tok.owner, 'POST', '/team', { user_id: U.carol, role: 'operator' }))).toBe('conflict');
  });

  it('removes members within scope only, never the last owner, and audits', async () => {
    const mk = async (userId: string, role: string, productId: string | null) => {
      const id = newId('tm');
      await env.DB.prepare('INSERT INTO team_members (id, user_id, role, product_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, userId, role, productId, Date.now()).run();
      return id;
    };
    const inA = await mk(U.dave, 'product_developer', w.a);
    const inB = await mk(U.dave, 'product_developer', w.b);
    expect(await errorCode(await api(w.tok.adminA, 'DELETE', `/team/${inB}`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'DELETE', `/team/${inA}`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'DELETE', '/team/tm_missing'))).toBe('forbidden');
    expect(await dbValue('SELECT 1 AS x FROM team_members WHERE id = ?', inB)).not.toBeNull();

    expect((await api(w.tok.adminA, 'DELETE', `/team/${inA}`)).status).toBe(204);
    expect(await dbValue('SELECT 1 AS x FROM team_members WHERE id = ?', inA)).toBeNull();
    expect((await auditRows('team.remove', w.a)).some((r) => r.target_id === inA)).toBe(true);
    expect(await errorCode(await api(w.tok.owner, 'DELETE', '/team/tm_missing'))).toBe('not_found');

    const ownerRow = (await dbValue<{ id: string }>("SELECT id FROM team_members WHERE role = 'owner'"))!.id;
    expect(await errorCode(await api(w.tok.owner, 'DELETE', `/team/${ownerRow}`))).toBe('invalid_request');
  });

  it('GET /team (platform-wide) is owner-only; product team listing is limited to that product', async () => {
    expect((await api(w.tok.owner, 'GET', '/team')).status).toBe(200);
    for (const t of [w.tok.operator, w.tok.adminA, w.tok.devA]) expect(await errorCode(await api(t, 'GET', '/team'))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminA, 'GET', `/products/${w.b}/team`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'GET', `/products/${w.a}/team`))).toBe('forbidden');
  });
});

describe('user lookup', () => {
  it('owner finds users by id or exact (case-insensitive) email and sees every membership', async () => {
    const byId = (await (await api(w.tok.owner, 'GET', `/users?user_id=${U.alice}`)).json()) as Json;
    expect(byId.user).toMatchObject({ id: U.alice, email: 'alice@example.com', name: 'Alice' });
    expect(byId.memberships.map((m: Json) => m.product_id).sort()).toEqual([w.a, w.b]);
    expect(byId.deletion_requests).toHaveLength(3);

    const byEmail = (await (await api(w.tok.owner, 'GET', '/users?email=bob@example.com')).json()) as Json;
    expect(byEmail.user.id).toBe(U.bob);
    expect(await errorCode(await api(w.tok.owner, 'GET', '/users?email=bob'))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'GET', '/users?email=nobody@example.com'))).toBe('not_found');
    expect(await errorCode(await api(w.tok.owner, 'GET', '/users'))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.owner, 'GET', `/users?user_id=${U.alice}&email=alice@example.com`))).toBe('validation_failed');
  });

  it("shows a product admin only memberships and deletion requests of their own product", async () => {
    const body = (await (await api(w.tok.adminA, 'GET', `/users?user_id=${U.alice}`)).json()) as Json;
    expect(body.memberships.map((m: Json) => m.product_id)).toEqual([w.a]);
    expect(body.deletion_requests.map((r: Json) => [r.scope, r.product_id])).toEqual([['product', w.a]]);
    expect(JSON.stringify(body)).not.toContain(w.b);
  });

  it('is not a global user oracle: users outside the admin\'s products look nonexistent', async () => {
    // Bob only belongs to B, Carol to nothing, and a made-up id does not exist: indistinguishable for A's admin.
    for (const q of [`user_id=${U.bob}`, `email=bob@example.com`, `user_id=${U.carol}`, 'user_id=usr_ghost']) {
      expect(await errorCode(await api(w.tok.adminA, 'GET', `/users?${q}`))).toBe('not_found');
    }
  });

  it('is denied to developers and operators, and writes an audit entry without the email', async () => {
    for (const t of [w.tok.devA, w.tok.operator]) expect(await errorCode(await api(t, 'GET', `/users?user_id=${U.alice}`))).toBe('forbidden');
    const entries = await auditRows('user.lookup');
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('alice@example.com');
  });

  it('lists product memberships for the product team with users:read', async () => {
    const list = ((await (await api(w.tok.adminA, 'GET', `/products/${w.a}/memberships`)).json()) as Json).memberships.map((m: Json) => m.user_id).sort();
    expect(list).toEqual([U.alice, U.dave].sort());
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/memberships`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'GET', `/products/${w.a}/memberships`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.operator, 'GET', `/products/${w.a}/memberships`))).toBe('forbidden');
  });
});

describe('membership changes', () => {
  const patch = (t: string, product: string, user: string, status: string) =>
    api(t, 'PATCH', `/products/${product}/memberships/${user}`, { status });
  const statusOf = async (user: string, product: string) =>
    (await dbValue<{ status: string }>('SELECT status FROM product_memberships WHERE user_id = ? AND product_id = ?', user, product))!.status;

  it('suspends, reactivates and revokes, revoking only that product\'s tokens and auditing each change', async () => {
    expect((await patch(w.tok.adminA, w.a, U.alice, 'suspended')).status).toBe(200);
    expect(await statusOf(U.alice, w.a)).toBe('suspended');
    expect(rpc.revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(rpc.revokeUserTokens.mock.calls[0]![0]).toMatchObject({ userId: U.alice, productId: w.a });

    expect((await patch(w.tok.adminA, w.a, U.alice, 'active')).status).toBe(200);
    expect(await statusOf(U.alice, w.a)).toBe('active');
    expect(rpc.revokeUserTokens).toHaveBeenCalledTimes(1); // reactivation revokes nothing

    expect((await patch(w.tok.owner, w.a, U.alice, 'revoked')).status).toBe(200);
    expect(rpc.revokeUserTokens).toHaveBeenCalledTimes(2);
    expect(await errorCode(await patch(w.tok.owner, w.a, U.alice, 'active'))).toBe('invalid_request');
    // No detour through 'suspended' either: revoked is terminal for admins.
    expect(await errorCode(await patch(w.tok.owner, w.a, U.alice, 'suspended'))).toBe('invalid_request');
    expect(await errorCode(await patch(w.tok.owner, w.a, U.alice, 'active'))).toBe('invalid_request');
    expect(await statusOf(U.alice, w.a)).toBe('revoked');
    expect(await statusOf(U.alice, w.b)).toBe('active'); // other products untouched

    const audits = (await auditRows('membership.update', w.a)).map((r) => JSON.parse(r.metadata));
    expect(audits).toEqual([{ from: 'active', to: 'suspended' }, { from: 'suspended', to: 'active' }, { from: 'active', to: 'revoked' }]);
  });

  it('applies the status even if token revocation fails, and a retry re-runs the revocation', async () => {
    rpc.revokeUserTokens.mockRejectedValueOnce(new Error('identity down'));
    expect((await patch(w.tok.adminA, w.a, U.dave, 'suspended')).status).toBe(500);
    expect(await statusOf(U.dave, w.a)).toBe('suspended');
    expect((await patch(w.tok.adminA, w.a, U.dave, 'suspended')).status).toBe(200);
    expect(rpc.revokeUserTokens).toHaveBeenCalledTimes(2);
  });

  it('validates input and unknown memberships', async () => {
    expect(await errorCode(await patch(w.tok.adminA, w.a, U.dave, 'banned'))).toBe('validation_failed');
    expect(await errorCode(await patch(w.tok.adminA, w.a, U.carol, 'suspended'))).toBe('not_found');
  });

  it('is denied to developers and operators, and across products', async () => {
    for (const t of [w.tok.devA, w.tok.operator]) expect(await errorCode(await patch(t, w.a, U.dave, 'revoked'))).toBe('forbidden');
    expect(await errorCode(await patch(w.tok.adminA, w.b, U.bob, 'revoked'))).toBe('forbidden');
    expect(await errorCode(await patch(w.tok.adminB, w.a, U.dave, 'revoked'))).toBe('forbidden');
    expect(await statusOf(U.bob, w.b)).toBe('active');
    expect(rpc.revokeUserTokens).not.toHaveBeenCalled();
  });
});
