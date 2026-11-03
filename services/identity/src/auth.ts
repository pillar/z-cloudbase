// Better Auth configuration for the identity worker (PRD §19.1, §19.4, §19.7).
// Everything protocol-related (sessions, password hashing, OAuth 2.1 / OIDC provider,
// JWKS, social login, anonymous users) is delegated to Better Auth and its plugins; the
// platform's own rules are engine plugins/hooks (oauth-policy, account-policy, social, system).
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ACCESS_TOKEN_TTL_S,
  IDENTITY_SESSION_TTL_S,
  REAUTH_WINDOW_S,
  REFRESH_TOKEN_TTL_S,
  isEnvironment,
  newId,
  newUserId,
  uuidv7,
} from '@z-cloudbase/contracts';
import { getCurrentAuthContext } from '@better-auth/core/context';
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { anonymous } from 'better-auth/plugins/anonymous';
import { jwt } from 'better-auth/plugins/jwt';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { accountPolicy } from './account-policy.ts';
import { writeAudit } from './audit.ts';
import { unconfiguredEmailAdapter, type EmailAdapter } from './email.ts';
import { magicLinkPlugins } from './magic-link.ts';
import { mfaPolicy } from './mfa-policy.ts';
import { oauthPolicy } from './oauth-policy.ts';
import { passkeyPlugin, passkeyPolicy } from './passkey.ts';
import { revokeOAuthTokens } from './revoke.ts';
import type { Lang, SignupMode } from './settings.ts';
import { signupPolicy } from './signup-policy.ts';
import { verifiedIdTokens } from './social.ts';
import { systemPrincipal } from './system.ts';
import { userAdmin } from './user-admin.ts';

export const AUTH_BASE_PATH = '/api/auth';
export const OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

/**
 * Signing keys (PRD §4.2 item 7, §19.4): a new key (new `kid`) is minted when the current one
 * reaches its rotation time; the retired key stays in the JWKS for the grace period so tokens it
 * signed keep verifying. The grace period is the PRD minimum: access-token TTL + 30 minutes.
 * The rotation interval is an initial value (not fixed by the PRD).
 */
export const SIGNING_KEY_ROTATION_S = 90 * 24 * 3600;
export const SIGNING_KEY_GRACE_S = ACCESS_TOKEN_TTL_S + 30 * 60;

/**
 * RFC 8707 resource for a product environment. Better Auth only mints JWT access tokens
 * for a requested `resource` (an absolute URI) and uses it as `aud`; the platform defines
 * it as `productAudience(client_id)` (PRD §19.3, docs/spikes/auth-engine.md CR-1).
 */
export { productAudience as productResource } from '@z-cloudbase/contracts';

export interface AuthDeps {
  db: D1Database;
  /** OIDC issuer, also Better Auth's baseURL origin (no trailing slash). */
  issuer: string;
  secret: string;
  /** Display name of this deployment (PLATFORM_NAME): engine appName, TOTP issuer label. */
  platformName: string;
  /** Google / Apple; enabled only when credentials are configured (see social.ts). */
  socialProviders?: BetterAuthOptions['socialProviders'];
  /** Origins allowed to POST to auth endpoints (product front-ends, console, Apple form_post). */
  trustedOrigins?: string[];
  /** Console sign-in must enroll TOTP first (REQUIRE_ADMIN_2FA); otherwise TOTP is optional for admins. */
  requireAdmin2fa?: boolean;
  /** Verification / reset mail; the local adapter writes the D1 outbox. */
  email?: EmailAdapter;
  /** A mail transport is configured: optional notices (e.g. a passkey was added) are sent only then. */
  mailAvailable?: boolean;
  /** Language of the request a mail is sent from (PRD §21.2); the engine's callbacks have no Hono context. */
  lang?: () => Lang;
  /** Registration mode and email verification (PRD §21.2); defaults: open, verification required. */
  signupMode?: SignupMode;
  requireEmailVerification?: boolean;
  /** Email / Password sign-up can work at all (false when verification is required but no mail transport exists). */
  emailSignupAvailable?: boolean;
  /** Passkeys (PRD §21.3); default on. */
  passkeys?: boolean;
  /** Magic link (PRD §21.3) with the deployment env (mail language); only when a mail transport exists. */
  magicLink?: { env: Env } | null;
}

/**
 * OAuth client_id is `{product_id}.{env}` (PRD §19.3). Better Auth's managed client
 * registration always calls `generateClientId()`, so the id is supplied through this
 * request-scoped store by `registerProductClient` (src/clients.ts).
 */
export const pendingClientId = new AsyncLocalStorage<string>();

const ID_PREFIX: Record<string, string> = { session: 'ses', account: 'acc' };

export function authOptions(deps: AuthDeps) {
  const email = deps.email ?? unconfiguredEmailAdapter;
  const lang = () => deps.lang?.();
  const mode = deps.signupMode ?? 'open';
  const requireVerification = deps.requireEmailVerification ?? true;
  return {
    appName: deps.platformName,
    baseURL: deps.issuer,
    basePath: AUTH_BASE_PATH,
    secret: deps.secret,
    // Native D1 support: the Kysely adapter detects a D1 binding (batch/exec/prepare)
    // and uses its built-in D1 dialect. D1 has no interactive transactions.
    database: deps.db,
    trustedOrigins: deps.trustedOrigins ?? [],
    emailAndPassword: {
      enabled: true,
      // Anti-enumeration: with auto sign-in off the engine answers sign-up identically whether or
      // not the email is registered; the owner of an existing account gets a notice instead.
      autoSignIn: false,
      // PRD §21.2: unverified addresses cannot sign in with a password (a new link is mailed on the attempt).
      requireEmailVerification: requireVerification,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      async sendResetPassword({ user, url }) {
        await email.send({ to: user.email, template: 'reset_password', payload: { url }, lang: lang() });
      },
      async onExistingUserSignUp({ user }) {
        await email.send({ to: user.email, template: 'existing_account', payload: {}, lang: lang() });
      },
      // Sessions are revoked by the engine; product refresh tokens go too (PRD §4.2 item 6).
      async onPasswordReset({ user }) {
        const { context } = await getCurrentAuthContext();
        await revokeOAuthTokens(context, user.id);
        await writeAudit(deps.db, {
          actorType: 'user',
          actorId: user.id,
          action: 'auth.password_reset',
          targetType: 'user',
          targetId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: requireVerification,
      expiresIn: 3600,
      async sendVerificationEmail({ user, url }) {
        await email.send({ to: user.email, template: 'verify_email', payload: { url }, lang: lang() });
      },
    },
    socialProviders: deps.socialProviders ?? {},
    user: {
      additionalFields: {
        lastActiveAt: { type: 'date', required: false, input: false },
        deletedAt: { type: 'date', required: false, input: false },
      },
    },
    session: {
      expiresIn: IDENTITY_SESSION_TTL_S,
      // In 1.7.7 `freshAge` only gates /list-sessions and /unlink-account; account-policy.ts
      // enforces the PRD §19.4 window on every sensitive account change.
      freshAge: REAUTH_WINDOW_S,
      additionalFields: {
        // Set when this identity session completed the second factor (src/mfa-policy.ts, PRD §19.11).
        twoFactorVerifiedAt: { type: 'date', required: false, input: false },
      },
    },
    account: {
      // Provider access/refresh tokens are encrypted at rest with the auth secret.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // PRD §4.2 item 12 / §19.7: never link by matching email on sign-in.
        disableImplicitLinking: true,
        // Explicit, session-bound linking (anonymous upgrade) must not depend on the
        // placeholder email matching the provider email: email equality is not identity.
        allowDifferentEmails: true,
      },
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax' },
      database: {
        generateId: ({ model }) => {
          if (model === 'user') return newUserId();
          const prefix = ID_PREFIX[model];
          return prefix ? newId(prefix) : uuidv7();
        },
      },
    },
    // Rate limiting is enforced in front of the engine with the Cloudflare Rate Limiting
    // bindings (src/rate-limit.ts, PRD §19.6); Better Auth's in-memory limiter is per-isolate
    // and not useful on Workers.
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          async after(session, ctx) {
            if (!ctx) return;
            await ctx.context.internalAdapter.updateUser(session.userId, { lastActiveAt: new Date() });
          },
        },
      },
    },
    plugins: [
      // Registration modes first: they refuse sign-up before any other plugin acts on it (PRD §21.2).
      signupPolicy({ mode, emailSignupAvailable: deps.emailSignupAvailable ?? true }),
      anonymous({
        // PRD §19.7: on conflict the anonymous account is kept unchanged until reclaimed.
        disableDeleteAnonymousUser: true,
      }),
      jwt({
        jwks: {
          keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
          jwksPath: '/jwks.json',
          rotationInterval: SIGNING_KEY_ROTATION_S,
          gracePeriod: SIGNING_KEY_GRACE_S,
        },
        jwt: { issuer: deps.issuer },
        disableSettingJwtHeader: true,
      }),
      // TOTP + backup codes (PRD §19.11; required for the console client only with REQUIRE_ADMIN_2FA, oauth-policy.ts). Once
      // enabled, email sign-in answers `twoFactorRedirect` until /two-factor/verify-* succeeds. Listed
      // before oauthProvider so its sign-in hook runs before the provider resumes an authorization.
      // Backup codes are stored encrypted (engine default); the password is asked when enabling or
      // disabling for users who have one.
      twoFactor({ issuer: deps.platformName, allowPasswordless: true }),
      mfaPolicy({ db: deps.db }),
      ...(deps.passkeys === false
        ? []
        : [passkeyPlugin({ issuer: deps.issuer, platformName: deps.platformName }), passkeyPolicy({ db: deps.db, mail: deps.mailAvailable ? { email, lang } : null })]),
      ...(deps.magicLink ? magicLinkPlugins({ env: deps.magicLink.env, mode, email }) : []),
      oauthProvider({
        loginPage: '/login',
        consentPage: '/consent',
        scopes: [...OIDC_SCOPES],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_S,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_S,
        refreshTokenReuseInterval: 0,
        allowDynamicClientRegistration: false,
        // Clients belong to the platform, not to the admin who registered them; otherwise
        // `oauthClient.userId` (ON DELETE CASCADE) would delete product clients with that user.
        clientReference: () => 'platform',
        generateClientId: () => {
          const id = pendingClientId.getStore();
          if (!id) throw new Error('OAuth clients must be registered through registerProductClient');
          return id;
        },
        // PRD §19.4 claims. iss/sub/aud/exp/iat/jti/sid/scope are owned by the engine.
        // The console client has no product metadata, so its tokens carry no pid/env/anon.
        customAccessTokenClaims: ({ user, metadata }) => {
          const pid = metadata?.product_id;
          const env = metadata?.env;
          if (typeof pid !== 'string' || !isEnvironment(env)) return {};
          return { pid, env, anon: Boolean((user as { isAnonymous?: boolean } | null | undefined)?.isAnonymous) };
        },
      }),
      systemPrincipal(),
      oauthPolicy({ db: deps.db, issuer: deps.issuer, requireAdmin2fa: deps.requireAdmin2fa ?? false }),
      // Bans and support impersonation (PRD §21.5). Before accountPolicy: its account hook must still see
      // an upgrading guest as anonymous.
      userAdmin({ db: deps.db }),
      accountPolicy({ db: deps.db }),
      verifiedIdTokens(),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;
