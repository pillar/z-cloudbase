import { createAuth, type Auth } from './auth.ts';
import { emailAdapterFor, magicLinkAvailable, mailAvailable } from './email.ts';
import { requestLang } from './i18n.ts';
import { platformName } from './platform.ts';
import { passkeysEnabled, requireEmailVerification, signupMode } from './settings.ts';
import { APPLE_ORIGIN, socialProviders } from './social.ts';

// One engine instance per env object (i.e. per isolate): Better Auth validates the schema on init.
const instances = new WeakMap<Env, Auth>();

/** Email / Password sign-up works unless verification is required and no mail can be sent (PRD §21.2). */
export const emailSignupAvailable = (env: Env) => !requireEmailVerification(env) || mailAvailable(env);

export function getAuth(env: Env): Auth {
  const existing = instances.get(env);
  if (existing) return existing;
  const mode = signupMode(env);
  // New Google / Apple users only in `open` mode; linked accounts keep signing in (PRD §21.2).
  const social = socialProviders(env, { disableSignUp: mode !== 'open' });
  const auth = createAuth({
    db: env.DB,
    issuer: env.ISSUER,
    secret: env.AUTH_SECRET,
    platformName: platformName(env),
    requireAdmin2fa: (env.REQUIRE_ADMIN_2FA as string) === 'true',
    socialProviders: social,
    trustedOrigins: social?.apple ? [APPLE_ORIGIN] : [],
    email: emailAdapterFor(env),
    mailAvailable: mailAvailable(env),
    lang: () => requestLang(env),
    signupMode: mode,
    requireEmailVerification: requireEmailVerification(env),
    emailSignupAvailable: emailSignupAvailable(env),
    passkeys: passkeysEnabled(env),
    magicLink: magicLinkAvailable(env) ? { env } : null,
  });
  instances.set(env, auth);
  return auth;
}
