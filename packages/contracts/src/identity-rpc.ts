import type { Environment } from './ids.ts';
import type { CreatedInvitation, Invitation, InvitationStatus, RpcResult } from './invitations.ts';
import type { BanState } from './user-admin.ts';

/**
 * RPC surface of the identity worker, exposed as the named entrypoint `IdentityRpc` and
 * reachable only through the api worker's service binding `IDENTITY` (never over public HTTP).
 * The identity worker implements it; the api worker consumes it.
 */
export interface IdentityRpcApi {
  /** Public signing keys (same document as `/api/auth/jwks.json`). */
  getJwks(): Promise<{ keys: Array<Record<string, unknown>> }>;
  /** Register (or update redirect URIs of) the OIDC client `{productId}.{env}` and link its resource. */
  upsertProductClient(input: {
    productId: string;
    env: Environment;
    redirectUris: string[];
    type: 'public' | 'confidential';
  }): Promise<{ clientId: string; clientSecret?: string; resource: string }>;
  /**
   * Revoke refresh tokens (and, when `productId` is absent, identity sessions) of a user.
   * With `productId`, only that product's clients are affected (leave-product, membership revoke).
   */
  revokeUserTokens(input: { userId: string; productId?: string; reason: string }): Promise<void>;
  /**
   * Global account deletion step (PRD §19.8): revoke all sessions and tokens, delete credentials
   * and linked accounts, and reduce the user row to a tombstone (id + deleted_at). Idempotent.
   */
  deleteUserIdentity(input: { userId: string; reason: string }): Promise<void>;
  /**
   * Ban (`ban` set) or unban (`ban: null`) a user platform-wide (PRD §21.5.1). The caller has checked
   * RBAC; the identity worker refuses team members (`conflict`) and unknown / deleted users (`not_found`),
   * writes the audit row and webhook events, and revokes every session and product token on ban.
   */
  setUserBan(input: {
    userId: string;
    actorId: string;
    requestId?: string;
    ban: { reason: string; expiresAt: string | null } | null;
  }): Promise<BanState & { changed: boolean }>;
  /** Identity part of a data export: profile and linked providers (no secrets, no hashes). */
  exportUserIdentity(input: { userId: string }): Promise<{
    user_id: string;
    email: string | null;
    email_verified: boolean;
    name: string | null;
    is_anonymous: boolean;
    created_at: string;
    providers: string[];
  }>;
  /**
   * Platform invitations (PRD §21.2). `actorId` / `requestId` are the calling admin and request, for the
   * audit entry written by identity. Errors (as `RpcResult`): `conflict` (account or pending invitation
   * exists; invitation no longer pending), `invalid_request` (link delivery while email verification is
   * required), `unavailable` (mail could not be sent), `not_found`.
   */
  createInvitation(input: {
    email: string;
    expiresInDays: number;
    lang?: 'zh' | 'en';
    actorId: string;
    requestId?: string;
  }): Promise<RpcResult<CreatedInvitation>>;
  listInvitations(input: { status?: InvitationStatus; limit: number; offset: number }): Promise<{ invitations: Invitation[] }>;
  revokeInvitation(input: { id: string; actorId: string; requestId?: string }): Promise<RpcResult<Invitation>>;
}
