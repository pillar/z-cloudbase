import {
  ApiError, CreateInvitationRequest, ENVIRONMENTS, ListInvitationsQuery, PRODUCT_ID_RE, type IdentityRpcApi, type RpcResult,
} from '@z-cloudbase/contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { writeAudit } from './audit.ts';
import { setUserBan } from './ban.ts';
import { upsertProductClient } from './clients.ts';
import { getAuth } from './instance.ts';
import { createInvitation, listInvitations, revokeInvitation } from './invitations.ts';
import { productClientIds, revokeAll, revokeOAuthTokens } from './revoke.ts';

const UserId = z.string().startsWith('usr_');
const Reason = z.string().min(1).max(200);

const UpsertClientInput = z.object({
  productId: z.string().regex(PRODUCT_ID_RE),
  env: z.enum(ENVIRONMENTS),
  redirectUris: z.array(z.url()).min(1).max(20),
  type: z.enum(['public', 'confidential']),
});
const RevokeInput = z.object({ userId: UserId, productId: z.string().regex(PRODUCT_ID_RE).optional(), reason: Reason });
const DeleteInput = z.object({ userId: UserId, reason: Reason });
const ExportInput = z.object({ userId: UserId });
const Actor = { actorId: UserId, requestId: z.string().max(100).optional() };
const CreateInvitationInput = z.object({
  email: CreateInvitationRequest.shape.email,
  expiresInDays: CreateInvitationRequest.shape.expires_in_days,
  lang: CreateInvitationRequest.shape.lang,
  ...Actor,
});
const RevokeInvitationInput = z.object({ id: z.string().startsWith('inv_').max(100), ...Actor });

/** Platform errors as data (RpcResult): Workers RPC would only carry the message of a thrown ApiError. */
async function result<T>(run: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}
const BanInput = z.object({
  userId: UserId,
  actorId: UserId,
  requestId: z.string().max(64).optional(),
  ban: z.object({ reason: z.string().min(1).max(500), expiresAt: z.string().nullable() }).nullable(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ApiError('validation_failed', 'Invalid identity RPC input', { issues: r.error.issues.map((i) => i.path.join('.')) });
  return r.data;
}

/** Placeholder email of a deleted user: `user.email` is NOT NULL UNIQUE in the engine schema. */
const tombstoneEmail = (userId: string) => `${userId}@deleted.invalid`;

/**
 * Identity worker RPC (packages/contracts identity-rpc.ts), reachable only through the api
 * worker's `IDENTITY` service binding. Callers are platform services, so each method acts as
 * the platform itself; authorization (console RBAC, deletion cooldown) is the caller's job.
 */
export class IdentityRpc extends WorkerEntrypoint<Env> implements IdentityRpcApi {
  private get auth() {
    return getAuth(this.env);
  }

  async getJwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
    return (await this.auth.api.getJwks()) as { keys: Array<Record<string, unknown>> };
  }

  async upsertProductClient(input: Parameters<IdentityRpcApi['upsertProductClient']>[0]) {
    return upsertProductClient(this.auth, parse(UpsertClientInput, input));
  }

  async revokeUserTokens(input: Parameters<IdentityRpcApi['revokeUserTokens']>[0]): Promise<void> {
    const { userId, productId, reason } = parse(RevokeInput, input);
    const ctx = await this.auth.$context;
    if (productId) await revokeOAuthTokens(ctx, userId, productClientIds(productId));
    else await revokeAll(ctx, userId);
    await writeAudit(this.env.DB, {
      actorType: 'system',
      actorId: 'identity',
      action: 'auth.tokens_revoked',
      productId: productId ?? null,
      targetType: 'user',
      targetId: userId,
      metadata: { reason, scope: productId ? 'product' : 'all' },
    });
  }

  async deleteUserIdentity(input: Parameters<IdentityRpcApi['deleteUserIdentity']>[0]): Promise<void> {
    const { userId, reason } = parse(DeleteInput, input);
    const ctx = await this.auth.$context;
    const user = await ctx.internalAdapter.findUserById(userId);
    if (!user) throw new ApiError('not_found', 'User not found');
    if ((user as { deletedAt?: Date | null }).deletedAt) return; // already a tombstone
    await revokeAll(ctx, userId);
    await ctx.internalAdapter.deleteAccounts(userId);
    // Pending password-reset links would otherwise recreate a credential for the tombstone.
    await ctx.adapter.deleteMany({ model: 'verification', where: [{ field: 'value', value: userId }] });
    await ctx.adapter.deleteMany({ model: 'oauthConsent', where: [{ field: 'userId', value: userId }] });
    // Second factor (TOTP secret, backup codes) and unused export links go with the credentials.
    await ctx.adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: userId }] });
    // Passkeys are credentials too (PRD §21.3); the tombstone row stays, so no cascade removes them.
    await this.env.DB.prepare('DELETE FROM passkey WHERE userId = ?').bind(userId).run();
    await this.env.DB.prepare('DELETE FROM export_links WHERE user_id = ?').bind(userId).run();
    await ctx.internalAdapter.updateUser(userId, {
      email: tombstoneEmail(userId),
      emailVerified: false,
      name: '',
      image: null,
      isAnonymous: false,
      twoFactorEnabled: false,
      lastActiveAt: null,
      deletedAt: new Date(),
    });
    await writeAudit(this.env.DB, {
      actorType: 'system',
      actorId: 'identity',
      action: 'auth.identity_deleted',
      targetType: 'user',
      targetId: userId,
      metadata: { reason },
    });
  }

  async setUserBan(input: Parameters<IdentityRpcApi['setUserBan']>[0]) {
    return setUserBan(this.env.DB, this.auth, parse(BanInput, input));
  }

  async exportUserIdentity(input: Parameters<IdentityRpcApi['exportUserIdentity']>[0]) {
    const { userId } = parse(ExportInput, input);
    const ctx = await this.auth.$context;
    const user = await ctx.internalAdapter.findUserById(userId);
    if (!user || (user as { deletedAt?: Date | null }).deletedAt) throw new ApiError('not_found', 'User not found');
    const accounts = await ctx.internalAdapter.findAccounts(userId);
    const anon = Boolean((user as { isAnonymous?: boolean | null }).isAnonymous);
    return {
      user_id: user.id,
      // Anonymous users only hold an engine-generated placeholder address.
      email: anon ? null : user.email,
      email_verified: user.emailVerified,
      name: user.name || null,
      is_anonymous: anon,
      created_at: new Date(user.createdAt).toISOString(),
      providers: [...new Set(accounts.map((a) => a.providerId))].sort(),
    };
  }

  // --- invitations (PRD §21.2); callers authorize (platform:manage) and pass the acting admin ---

  async createInvitation(input: Parameters<IdentityRpcApi['createInvitation']>[0]) {
    const i = parse(CreateInvitationInput, input);
    return result(() =>
      createInvitation(this.env, { email: i.email, expiresInDays: i.expiresInDays, lang: i.lang, actorId: i.actorId, requestId: i.requestId }),
    );
  }

  async listInvitations(input: Parameters<IdentityRpcApi['listInvitations']>[0]) {
    return listInvitations(this.env.DB, parse(ListInvitationsQuery, input));
  }

  async revokeInvitation(input: Parameters<IdentityRpcApi['revokeInvitation']>[0]) {
    const i = parse(RevokeInvitationInput, input);
    return result(() => revokeInvitation(this.env.DB, i));
  }
}
