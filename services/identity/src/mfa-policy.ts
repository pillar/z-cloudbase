// Admin MFA (PRD §19.9, §19.11): TOTP and backup codes come from Better Auth's two-factor plugin;
// this plugin only records on the identity session that it completed the second factor, so the
// console authorization (oauth-policy.ts) can require it, and audits enabling / disabling.
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { writeAudit } from './audit.ts';
import { PASSKEY_SIGN_IN_PATH } from './passkey.ts';

/** Engine endpoints that verify a second factor (sign-in challenge, enrollment, step-up). */
export const SECOND_FACTOR_PATHS: ReadonlySet<string> = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/**
 * Sessions created by these engine endpoints passed a second factor: the TOTP / backup-code endpoints,
 * and a passkey sign-in, which requires user verification and so is multi-factor by itself (PRD §21.3).
 */
export const MFA_SESSION_PATHS: ReadonlySet<string> = new Set([...SECOND_FACTOR_PATHS, PASSKEY_SIGN_IN_PATH]);

/**
 * What the console authorization still needs from this session: an MFA method (`setup`, only when the
 * deployment requires admin 2FA and the admin has neither TOTP nor a passkey), a second factor on this
 * session (`verify`: TOTP code or passkey on the second-factor page; e.g. a session from a password,
 * social or magic-link sign-in), or nothing. A passkey is optional unless enrollment is required.
 */
export function consoleMfaStep(
  s: { user: object; session: object },
  requireEnrollment: boolean,
  hasPasskey = false,
): 'setup' | 'verify' | null {
  if ((s.session as { twoFactorVerifiedAt?: Date | string | null }).twoFactorVerifiedAt) return null;
  if ((s.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return 'verify';
  if (!requireEnrollment) return null;
  return hasPasskey ? 'verify' : 'setup';
}

export async function hasPasskey(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM passkey WHERE userId = ? LIMIT 1').bind(userId).first());
}

export function mfaPolicy(deps: { db: D1Database }) {
  const { db } = deps;
  const audit = (userId: string, action: string) =>
    writeAudit(db, { actorType: 'user', actorId: userId, action, targetType: 'user', targetId: userId });
  return {
    id: 'z-cloudbase-mfa-policy',
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              // A session created by a second-factor endpoint (sign-in challenge passed, or the
              // enrollment that rotates the session) has completed the second factor.
              async before(session, ctx) {
                if (!MFA_SESSION_PATHS.has(ctx?.path ?? '')) return;
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
