// Platform-wide ban / unban (PRD §21.5.1), executed by the identity worker for the admin API (IdentityRpc
// `setUserBan`). The ban fields, the audit row and the webhook outbox are written in one D1 batch; then
// every session and product token of the user is revoked and running impersonations of them end.
import { ApiError, BAN_MAX_DURATION_DAYS, type BanState } from '@z-cloudbase/contracts';
import { fanOutStatements, userEventTargets } from '@z-cloudbase/webhooks';
import { auditStatement } from './audit.ts';
import type { Auth } from './auth.ts';
import { revokeAll } from './revoke.ts';
import { endImpersonations, isBanned } from './user-admin.ts';
import { deliverSoon, prepareAll } from './webhooks.ts';

export interface SetBanInput {
  userId: string;
  actorId: string;
  requestId?: string;
  /** null = unban. */
  ban: { reason: string; expiresAt: string | null } | null;
}

interface UserRow {
  id: string;
  deletedAt: string | null;
  banned: number | null;
  banReason: string | null;
  banExpires: string | null;
}

export async function setUserBan(db: D1Database, auth: Auth, input: SetBanInput): Promise<BanState & { changed: boolean }> {
  const user = await db.prepare('SELECT id, deletedAt, banned, banReason, banExpires FROM "user" WHERE id = ?')
    .bind(input.userId).first<UserRow>();
  if (!user || user.deletedAt) throw new ApiError('not_found', 'User not found');
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const audit = (action: string, metadata: Record<string, unknown>) =>
    auditStatement(db, { actorType: 'user', actorId: input.actorId, action, targetType: 'user', targetId: user.id, requestId: input.requestId ?? null, metadata });

  if (!input.ban) {
    if (!user.banned) return { changed: false, banned: false, expires_at: null, reason: null };
    const fan = fanOutStatements(await userEventTargets(db, user.id, 'user.unbanned'), 'user.unbanned', { user_id: user.id, reason: 'admin' }, now);
    await db.batch([
      db.prepare('UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL, updatedAt = ? WHERE id = ?').bind(nowIso, user.id),
      audit('user.unban', { reason: 'admin', was_expired: !isBanned(user, now) }),
      ...prepareAll(db, fan.statements),
    ]);
    deliverSoon(db, fan.messageIds);
    return { changed: true, banned: false, expires_at: null, reason: null };
  }

  // Team members are removed from the team first (they also hold console access).
  if (await db.prepare('SELECT 1 AS x FROM team_members WHERE user_id = ? LIMIT 1').bind(user.id).first()) {
    throw new ApiError('conflict', 'Platform team members cannot be banned; remove them from the team first');
  }
  let expiresAt: string | null = null;
  if (input.ban.expiresAt) {
    const t = Date.parse(input.ban.expiresAt);
    if (!Number.isFinite(t) || t <= now || t > now + BAN_MAX_DURATION_DAYS * 24 * 3600 * 1000) {
      throw new ApiError('validation_failed', `expires_at must be in the future and at most ${BAN_MAX_DURATION_DAYS} days ahead`);
    }
    expiresAt = new Date(t).toISOString();
  }
  const fan = fanOutStatements(await userEventTargets(db, user.id, 'user.banned'), 'user.banned', { user_id: user.id, expires_at: expiresAt }, now);
  await db.batch([
    db.prepare('UPDATE "user" SET banned = 1, banReason = ?, banExpires = ?, updatedAt = ? WHERE id = ?')
      .bind(input.ban.reason, expiresAt, nowIso, user.id),
    audit('user.ban', { reason: input.ban.reason, expires_at: expiresAt, previously_banned: isBanned(user, now) }),
    // A support session that was requested for this user can no longer start.
    db.prepare(`UPDATE impersonations SET status = 'cancelled', ended_at = ?, end_reason = 'target_banned' WHERE target_id = ? AND status = 'pending'`)
      .bind(now, user.id),
    ...prepareAll(db, fan.statements),
  ]);
  await endImpersonations(db, { targetId: user.id }, 'target_banned', { type: 'user', id: input.actorId });
  // Sessions (impersonation ones included: their tokens go with them, migration 0018) and product tokens.
  await revokeAll(await auth.$context, user.id);
  deliverSoon(db, fan.messageIds);
  return { changed: true, banned: true, expires_at: expiresAt, reason: input.ban.reason };
}
