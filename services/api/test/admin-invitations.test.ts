// Admin API: platform invitations (PRD §21.2). Owner only; every other principal — operator, product
// admins and developers of any product, product tokens — is refused before identity is called.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, errorCode, initApp, makeWorld, rawRequest, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

const INVITATION = {
  id: 'inv_01900000-0000-7000-8000-000000000001', email: 'new@example.com', status: 'pending', delivery: 'email', created_by: 'x',
  created_at: '2026-11-04T00:00:00.000Z', expires_at: '2026-11-11T00:00:00.000Z', used_at: null, used_by: null, revoked_at: null,
};
const rpc = vi.hoisted(() => ({ createInvitation: vi.fn(), listInvitations: vi.fn(), revokeInvitation: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));

let w: World;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('inv');
});
beforeEach(() => {
  rpc.createInvitation.mockReset().mockResolvedValue({ ok: true, value: INVITATION });
  rpc.listInvitations.mockReset().mockResolvedValue({ invitations: [INVITATION] });
  rpc.revokeInvitation.mockReset().mockResolvedValue({ ok: true, value: { ...INVITATION, status: 'revoked' } });
});

describe('invitations', () => {
  it('the owner creates an invitation; identity gets the acting admin and the request id, never ids from the body', async () => {
    const res = await api(w.tok.owner, 'POST', '/invitations', { email: 'new@example.com', expires_in_days: 3, lang: 'zh', actorId: 'usr_forged' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ id: INVITATION.id, status: 'pending' });
    expect(rpc.createInvitation).toHaveBeenCalledWith({
      email: 'new@example.com', expiresInDays: 3, lang: 'zh', actorId: w.users.owner, requestId: expect.stringMatching(/^req_/),
    });
  });

  it('defaults the lifetime to 7 days and validates the body', async () => {
    await api(w.tok.owner, 'POST', '/invitations', { email: 'x@example.com' });
    expect(rpc.createInvitation.mock.calls[0]![0]).toMatchObject({ expiresInDays: 7 });
    for (const body of [{ email: 'nope' }, { email: 'x@example.com', expires_in_days: 0 }, { email: 'x@example.com', expires_in_days: 31 }, {}]) {
      const res = await api(w.tok.owner, 'POST', '/invitations', body);
      expect(res.status).toBe(400);
    }
    expect((await rawRequest('/invitations', { method: 'POST', headers: { authorization: `Bearer ${w.tok.owner}`, 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
  });

  it('maps identity errors (sent as data over RPC) to the platform error format', async () => {
    rpc.createInvitation.mockResolvedValueOnce({ ok: false, error: { code: 'conflict', message: 'An account with this email already exists' } });
    const conflict = await api(w.tok.owner, 'POST', '/invitations', { email: 'taken@example.com' });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('conflict');
    rpc.revokeInvitation.mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'Invitation not found' } });
    expect((await api(w.tok.owner, 'DELETE', `/invitations/${INVITATION.id}`)).status).toBe(404);
  });

  it('lists with filters and revokes as the acting owner', async () => {
    const list = await api(w.tok.owner, 'GET', '/invitations?status=pending&limit=10');
    expect(list.status).toBe(200);
    expect(((await list.json()) as Json).invitations).toHaveLength(1);
    expect(rpc.listInvitations).toHaveBeenCalledWith({ status: 'pending', limit: 10, offset: 0 });
    expect((await api(w.tok.owner, 'GET', '/invitations?status=bogus')).status).toBe(400);

    const del = await api(w.tok.owner, 'DELETE', `/invitations/${INVITATION.id}`);
    expect(del.status).toBe(200);
    expect(rpc.revokeInvitation).toHaveBeenCalledWith({ id: INVITATION.id, actorId: w.users.owner, requestId: expect.stringMatching(/^req_/) });
    expect((await api(w.tok.owner, 'DELETE', '/invitations/not-an-id')).status).toBe(404);
  });

  it('is closed to operators and to every product-scoped principal, for every route', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/invitations'],
      ['POST', '/invitations', { email: 'x@example.com' }],
      ['DELETE', `/invitations/${INVITATION.id}`],
    ];
    for (const [method, path, body] of routes) {
      for (const who of ['operator', 'adminA', 'devA', 'adminB', 'nobody'] as const) {
        const res = await api(w.tok[who], method, path, body);
        expect(res.status, `${who} ${method} ${path}`).toBe(403);
        expect(await errorCode(res)).toBe('forbidden');
      }
      expect((await api(w.tok.product, method, path, body)).status, `product token ${method} ${path}`).toBe(401);
      expect((await api(null, method, path, body)).status).toBe(401);
    }
    expect(rpc.createInvitation).not.toHaveBeenCalled();
    expect(rpc.listInvitations).not.toHaveBeenCalled();
    expect(rpc.revokeInvitation).not.toHaveBeenCalled();
  });
});
