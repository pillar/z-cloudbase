import { createAuth, type Auth } from './auth.ts';
import { emailAdapterFor } from './email.ts';
import { platformName } from './platform.ts';
import { APPLE_ORIGIN, socialProviders } from './social.ts';

// One engine instance per env object (i.e. per isolate): Better Auth validates the schema on init.
const instances = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  const existing = instances.get(env);
  if (existing) return existing;
  const social = socialProviders(env);
  const auth = createAuth({
    db: env.DB,
    issuer: env.ISSUER,
    secret: env.AUTH_SECRET,
    platformName: platformName(env),
    requireAdmin2fa: (env.REQUIRE_ADMIN_2FA as string) === 'true',
    socialProviders: social,
    trustedOrigins: social?.apple ? [APPLE_ORIGIN] : [],
    email: emailAdapterFor(env),
  });
  instances.set(env, auth);
  return auth;
}
