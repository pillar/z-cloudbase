// Registration modes (PRD §21.2) as engine policy. Every way the engine can create a user — Email /
// Password sign-up, anonymous (guest) sign-in, a new Google / Apple user, a new magic-link user — goes
// through `user.create.before`; outside `open` mode it refuses anything but a registration running under
// a claimed invitation (`redemption`, src/invitations.ts). Endpoint hooks give the common paths a clear
// error first. Server-side code outside an engine endpoint (operator setup, §20.3) is not affected.
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { redemption } from './invitations.ts';
import type { SignupMode } from './settings.ts';

export const SIGNUP_CLOSED = { code: 'SIGNUP_CLOSED', message: 'Registration is not open on this platform' } as const;

/** May the engine create a user for this email right now? */
export function mayCreateUser(mode: SignupMode, email: string | null | undefined): boolean {
  if (mode === 'open') return true;
  const r = redemption.getStore();
  return mode === 'invite' && Boolean(r && email && r.email === email.trim().toLowerCase());
}

export function signupPolicy(deps: { mode: SignupMode; emailSignupAvailable: boolean }) {
  const { mode } = deps;
  return {
    id: 'z-cloudbase-signup-policy',
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              async before(user, ctx) {
                if (!ctx) return; // not an engine endpoint (operator setup, platform RPC)
                if (!mayCreateUser(mode, user.email)) return false;
                // An invitation delivered by mail proves the mailbox it was sent to.
                const r = redemption.getStore();
                if (r?.verified && r.email === user.email.toLowerCase()) return { data: { ...user, emailVerified: true } };
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-up/email' || ctx.path === '/sign-in/anonymous',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === '/sign-in/anonymous') {
              // Guests are refused outside `open`: an anonymous account could later add an email and
              // password, which would bypass the invitation.
              if (mode !== 'open') throw new APIError('FORBIDDEN', SIGNUP_CLOSED);
              return;
            }
            if (!deps.emailSignupAvailable) throw new APIError('FORBIDDEN', SIGNUP_CLOSED);
            const email = typeof ctx.body?.email === 'string' ? ctx.body.email : null;
            if (!mayCreateUser(mode, email)) throw new APIError('FORBIDDEN', SIGNUP_CLOSED);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
