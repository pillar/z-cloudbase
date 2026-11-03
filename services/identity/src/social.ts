// Google / Apple sign-in (PRD §4.2 items 8, 9). The engine's built-in providers call the real
// provider endpoints; tests only route those fetches to the local mock IdP.
import { verifyProviderIdToken, type BetterAuthOptions, type BetterAuthPlugin, type OAuthProvider } from 'better-auth';

/** Apple POSTs its callback cross-site (`response_mode=form_post`); it must be a trusted origin. */
export const APPLE_ORIGIN = 'https://appleid.apple.com';

export interface SocialSecrets {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  /** Apple's client secret is a short-lived ES256 JWT minted from the team key (outside this worker). */
  APPLE_CLIENT_SECRET?: string;
}

/**
 * Enabled only when credentials are configured; the POC has none outside tests (PRD D10).
 * Apple's `appBundleIdentifier` is deliberately not set: it would make the engine expect the
 * app bundle id as id_token audience, which breaks the web (Services ID) flow. Native id_token
 * exchange is P1 (PRD §19.4).
 */
export function socialProviders(s: SocialSecrets): BetterAuthOptions['socialProviders'] {
  return {
    ...(s.GOOGLE_CLIENT_ID && s.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: s.GOOGLE_CLIENT_ID, clientSecret: s.GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(s.APPLE_CLIENT_ID && s.APPLE_CLIENT_SECRET
      ? { apple: { clientId: s.APPLE_CLIENT_ID, clientSecret: s.APPLE_CLIENT_SECRET } }
      : {}),
  };
}

const VERIFIED_PROVIDERS = new Set(['google', 'apple']);

/**
 * In the redirect (code) flow Better Auth 1.7.7's Google and Apple providers only decode the
 * id_token from the token response; they neither verify its signature nor bind a nonce
 * (docs/spikes/auth-engine.md R6). The engine already supports nonce binding for providers
 * that declare `requiresIdTokenNonce`: it mints a nonce into the OAuth state, hands it to
 * `createAuthorizationURL` and back to `getUserInfo` as `expectedIdTokenNonce`. This plugin
 * opts the two providers in and verifies the id_token with the engine's own
 * `verifyProviderIdToken` (provider JWKS, issuer, audience, max age, nonce) before any claim
 * is trusted. A failed check makes `getUserInfo` return null, which the engine turns into
 * `error=unable_to_get_user_info` without creating or linking anything.
 */
export function verifiedIdTokens() {
  return {
    id: 'cloudbase-verified-id-tokens',
    init: (ctx) => ({
      context: {
        socialProviders: ctx.socialProviders.map((p) => (VERIFIED_PROVIDERS.has(p.id) ? withIdTokenVerification(p) : p)),
      },
    }),
  } satisfies BetterAuthPlugin;
}

function withIdTokenVerification(provider: OAuthProvider): OAuthProvider {
  return {
    ...provider,
    requiresIdTokenNonce: true,
    async createAuthorizationURL(data) {
      const url = await provider.createAuthorizationURL(data);
      if (data.idTokenNonce) url.searchParams.set('nonce', data.idTokenNonce);
      return url;
    },
    async getUserInfo(tokens) {
      if (!tokens.idToken || !tokens.expectedIdTokenNonce) return null;
      if (!(await verifyProviderIdToken(provider, tokens.idToken, tokens.expectedIdTokenNonce))) return null;
      return provider.getUserInfo(tokens);
    },
  };
}
