import { ApiError, CreateInvitationRequest, ListInvitationsQuery, type RpcResult } from '@z-cloudbase/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { identity } from '../../identity.ts';
import { authorize } from '../../middleware/auth.ts';
import { readJson, readQuery } from './util.ts';

// Platform invitations (PRD §21.2). Owner only (`platform:manage`): invitations carry email addresses.
// The identity worker owns the table, mails the link and writes the audit entries (invitation.create /
// invitation.revoke) with this admin as actor.
export const invitationRoutes = new Hono<AppEnv>();

/** Identity's platform errors arrive as data (RpcResult) and are rethrown here. */
function unwrap<T>(r: RpcResult<T>): T {
  if (!r.ok) throw new ApiError(r.error.code, r.error.message);
  return r.value;
}

invitationRoutes.get('/invitations', async (c) => {
  authorize(c, 'platform:manage');
  const q = readQuery(c, ListInvitationsQuery);
  return c.json(await identity(c.env).listInvitations(q));
});

invitationRoutes.post('/invitations', async (c) => {
  authorize(c, 'platform:manage');
  const body = await readJson(c, CreateInvitationRequest);
  const created = unwrap(
    await identity(c.env).createInvitation({
      email: body.email,
      expiresInDays: body.expires_in_days,
      ...(body.lang ? { lang: body.lang } : {}),
      actorId: c.get('admin').userId,
      requestId: c.get('requestId'),
    }),
  );
  // A link-delivery invitation carries its URL once: never cache it.
  c.header('cache-control', 'no-store');
  return c.json(created, 201);
});

invitationRoutes.delete('/invitations/:id', async (c) => {
  authorize(c, 'platform:manage');
  const id = c.req.param('id');
  if (!/^inv_[0-9a-f-]{36}$/.test(id)) throw new ApiError('not_found', 'Invitation not found');
  return c.json(unwrap(await identity(c.env).revokeInvitation({ id, actorId: c.get('admin').userId, requestId: c.get('requestId') })));
});
