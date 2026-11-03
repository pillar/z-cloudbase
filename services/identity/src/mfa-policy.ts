// Admin MFA (PRD §19.9, §19.11): TOTP and backup codes come from Better Auth's two-factor plugin;
// this plugin only records on the identity session that it completed the second factor, so the
// console authorization (oauth-policy.ts) can require it, and audits enabling / disabling.
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { writeAudit } from './audit.ts';

/** Engine endpoints that verify a second factor (sign-in challenge, enrollment, step-up). */
export const SECOND_FACTOR_PATHS: ReadonlySet<string> = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/**
 * What the console authorization still needs from this session: TOTP enrollment (`setup`, only when
 * the deployment requires admin 2FA), a second factor on this session (`verify`: TOTP is enabled
 * but this session did not pass it, e.g. a session from social sign-in or from before the
 * enrollment), or nothing.
 */
export function consoleMfaStep(s: { user: object; session: object }, requireEnrollment: boolean): 'setup' | 'verify' | null {
  if (!(s.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return requireEnrollment ? 'setup' : null;
  if (!(s.session as { twoFactorVerifiedAt?: Date | string | null }).twoFactorVerifiedAt) return 'verify';
  return null;
}

export function mfaPolicy(deps: { db: D1Database }) {
  const { db } = deps;
  const audit = (userId: string, action: string) =>
    writeAudit(db, { actorType: 'user', actorId: userId, action, targetType: 'user', targetId: userId });
  return {
    id: 'cloudbase-mfa-policy',
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              // A session created by a second-factor endpoint (sign-in challenge passed, or the
              // enrollment that rotates the session) has completed the second factor.
              async before(session, ctx) {
                if (!SECOND_FACTOR_PATHS.has(ctx?.path ?? '')) return;
                return { data: { ...session, twoFactorVerifiedAt: new Date() } };
              },
            },
          },
        },
      },
    }),
    hooks: {
      after: [
        {
          matcher: (ctx) => SECOND_FACTOR_PATHS.has(ctx.path ?? '') || ctx.path === '/two-factor/disable',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || isAPIError(returned)) return;
            // The session the request came with (none during the sign-in challenge).
            const current = await getSessionFromCtx(ctx);
            if (!current) return;
            if (ctx.path === '/two-factor/disable') return audit(current.user.id, 'auth.mfa_disabled');
            // Enrollment: the engine enabled TOTP and replaced the session (marked on creation above).
            if (ctx.context.newSession) return audit(current.user.id, 'auth.mfa_enabled');
            // Step-up: the code was verified for the existing session, which the engine keeps.
            await ctx.context.internalAdapter.updateSession(current.session.token, { twoFactorVerifiedAt: new Date() });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
