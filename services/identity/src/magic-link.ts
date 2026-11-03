// Magic link sign-in (PRD §21.3): Better Auth's magic-link plugin with hashed, single-use 5-minute
// tokens, no sign-up outside `open` mode, no link for accounts with TOTP (mail alone must not bypass the
// second factor; they get a notice instead), and callbacks restricted to this issuer's own pages.
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins/magic-link';
import { AUTH_BASE_PATH } from './auth.ts';
import type { EmailAdapter } from './email.ts';
import { requestLang } from './i18n.ts';
import type { SignupMode } from './settings.ts';

export const MAGIC_LINK_TTL_S = 5 * 60;

/**
 * Where a magic link may land: the account page, the sign-in page (error display), or this issuer's
 * authorization endpoint (continuing an authorization request). Relative paths only.
 */
export function allowedMagicLinkTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  const u = new URL(value, 'https://issuer.invalid');
  if (u.origin !== 'https://issuer.invalid') return false;
  return u.pathname === '/account' || u.pathname === '/login' || u.pathname === `${AUTH_BASE_PATH}/oauth2/authorize`;
}

export function magicLinkPlugins(deps: { env: Env; mode: SignupMode; email: EmailAdapter }) {
  const policy = {
    id: 'z-cloudbase-magic-link-policy',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/magic-link',
          handler: createAuthMiddleware(async (ctx) => {
            const b = (ctx.body ?? {}) as Record<string, unknown>;
            for (const field of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) {
              if (!allowedMagicLinkTarget(b[field])) {
                throw new APIError('BAD_REQUEST', { code: 'INVALID_CALLBACK', message: `${field} must be a page of this issuer` });
              }
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  const plugin = magicLink({
    expiresIn: MAGIC_LINK_TTL_S,
    storeToken: 'hashed',
    disableSignUp: deps.mode !== 'open',
    async sendMagicLink({ email, url }, ctx) {
      const lang = requestLang(deps.env);
      const found = ctx ? await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase()) : null;
      const user = found?.user as { twoFactorEnabled?: boolean | null; deletedAt?: Date | null } | undefined;
      if (user?.deletedAt) return;
      if (user?.twoFactorEnabled) {
        await deps.email.send({ to: email, template: 'magic_link_unavailable', payload: {}, lang });
        return;
      }
      // No account and no sign-up: nothing to send (the page answers the same either way).
      if (!user && deps.mode !== 'open') return;
      await deps.email.send({ to: email, template: 'magic_link', payload: { url }, lang });
    },
  });
  return [plugin, policy] as const;
}
