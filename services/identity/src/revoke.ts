import { ENVIRONMENTS, clientId } from '@z-cloudbase/contracts';

/** The engine context parts used here (Better Auth's AuthContext satisfies it). */
export interface EngineStore {
  adapter: { deleteMany(data: { model: string; where: Array<{ field: string; value: string | string[]; operator?: 'in' }> }): Promise<unknown> };
  internalAdapter: { deleteUserSessions(userId: string): Promise<unknown> };
}

/** The OIDC clients of a product: one per environment (`{product_id}.{env}`). */
export const productClientIds = (productId: string) => ENVIRONMENTS.map((env) => clientId(productId, env));

/**
 * Delete a user's refresh tokens and stored (opaque) access tokens, optionally only for some
 * clients. JWT access tokens are not stored; they expire within ACCESS_TOKEN_TTL_S (PRD §19.4).
 */
export async function revokeOAuthTokens(ctx: EngineStore, userId: string, clientIds?: string[]): Promise<void> {
  const where = [
    { field: 'userId', value: userId },
    ...(clientIds ? [{ field: 'clientId', operator: 'in' as const, value: clientIds }] : []),
  ];
  // Access tokens first: they reference refresh tokens.
  await ctx.adapter.deleteMany({ model: 'oauthAccessToken', where });
  await ctx.adapter.deleteMany({ model: 'oauthRefreshToken', where });
}

/** Revoke everything: identity-domain sessions and all OAuth tokens of the user. */
export async function revokeAll(ctx: EngineStore, userId: string): Promise<void> {
  await ctx.internalAdapter.deleteUserSessions(userId);
  await revokeOAuthTokens(ctx, userId);
}
