// Account-level security policy (PRD §4.2 items 6, 11, 12; §19.4; §19.7) as engine hooks:
// the 5-minute re-authentication window for sensitive account changes, the in-place anonymous
// upgrade when a credential is linked, and audit events for link / unlink.
import { REAUTH_WINDOW_S } from '@z-cloudbase/contracts';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { writeAudit } from './audit.ts';

/**
 * Engine endpoints that change how the account can be signed into or remove it. In 1.7.7 the
 * engine's own `freshAge` only guards /unlink-account and /list-sessions.
 */
export const REAUTH_PATHS: ReadonlySet<string> = new Set([
  '/link-social',
  '/unlink-account',
  '/change-password',
  '/change-email',
  '/delete-user',
  '/two-factor/disable',
  // Removing a passkey (PRD §21.3); adding one already needs the engine's fresh session.
  '/passkey/delete-passkey',
]);

/** A session is fresh when it was created (i.e. the user authenticated) within REAUTH_WINDOW_S. */
export function isFreshSession(createdAt: Date | string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() < REAUTH_WINDOW_S * 1000;
}

export function accountPolicy(deps: { db: D1Database }) {
  const { db } = deps;
  return {
    id: 'z-cloudbase-account-policy',
    init: () => ({
      options: {
        databaseHooks: {
          account: {
            create: {
              async after(account, ctx) {
                if (!ctx) return;
                const user = await ctx.context.internalAdapter.findUserById(account.userId);
                if (!user) return;
                // Linking any credential to an anonymous user upgrades it in place (same id, §19.7).
                const wasAnonymous = Boolean((user as { isAnonymous?: boolean | null }).isAnonymous);
                if (wasAnonymous) await ctx.context.internalAdapter.updateUser(account.userId, { isAnonymous: false });
                // A user's first credential is registration; any later one is a link.
                const accounts = await ctx.context.internalAdapter.findAccounts(account.userId);
                if (!wasAnonymous && accounts.length < 2) return;
                await writeAudit(db, {
                  actorType: 'user',
                  actorId: account.userId,
                  action: 'auth.identity_linked',
                  targetType: 'user',
                  targetId: account.userId,
                  metadata: { provider: account.providerId, upgraded_anonymous: wasAnonymous },
                });
              },
            },
            delete: {
              // Only the user-initiated /unlink-account; deletions by IdentityRpc audit themselves.
              async after(account, ctx) {
                if (ctx?.path !== '/unlink-account') return;
                await writeAudit(db, {
                  actorType: 'user',
                  actorId: account.userId,
                  action: 'auth.identity_unlinked',
                  targetType: 'user',
                  targetId: account.userId,
                  metadata: { provider: account.providerId },
                });
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => REAUTH_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return; // the endpoint itself answers 401
            // An anonymous user has nothing to re-authenticate with; linking is how it upgrades.
            if ((session.user as { isAnonymous?: boolean | null }).isAnonymous) return;
            if (!isFreshSession(session.session.createdAt)) {
              throw new APIError('FORBIDDEN', {
                code: 'SESSION_NOT_FRESH',
                message: `Sign in again: this action requires a sign-in within the last ${REAUTH_WINDOW_S / 60} minutes`,
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
