// Deployment settings of the identity worker that PRD §21.2–21.4 define (wrangler vars set by
// `pnpm platform:deploy`). Every value is validated here; an invalid value falls back to the default
// instead of reaching a page, a CSS rule or the engine.

export type SignupMode = 'open' | 'invite' | 'closed';
export type Lang = 'zh' | 'en';
export const LANGS: readonly Lang[] = ['zh', 'en'];

/** Untyped view of the vars: `wrangler types` only knows the ones in wrangler.jsonc. */
const vars = (env: Env) => env as unknown as Record<string, unknown>;
const str = (env: Env, name: string) => {
  const v = vars(env)[name];
  return typeof v === 'string' ? v.trim() : '';
};

export function signupMode(env: Env): SignupMode {
  const v = str(env, 'SIGNUP_MODE');
  return v === 'invite' || v === 'closed' ? v : 'open';
}

/** Default true: only an explicit `false` turns verification off (PRD §21.2). */
export const requireEmailVerification = (env: Env) => str(env, 'REQUIRE_EMAIL_VERIFICATION') !== 'false';
export const passkeysEnabled = (env: Env) => str(env, 'PASSKEYS') !== 'false';
/** Magic link also needs a mail transport (see `magicLinkAvailable` in email.ts). */
export const magicLinkSetting = (env: Env) => str(env, 'MAGIC_LINK') !== 'false';

export function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en';
}

export function defaultLang(env: Env): Lang {
  const v = str(env, 'DEFAULT_LANG');
  return isLang(v) ? v : 'en';
}

// --- branding (PRD §21.4) -----------------------------------------------------------------------

export const LOGO_URL_MAX = 2048;
export const TAGLINE_MAX = 200;

/** https only, no whitespace, quotes, angle brackets or backslashes (also checked by the deploy script). */
export function validLogoUrl(v: string): boolean {
  if (!v || v.length > LOGO_URL_MAX || /[\s"'<>\\`]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export const validColor = (v: string) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
export const validTagline = (v: string) => v.length > 0 && v.length <= TAGLINE_MAX && !/[\r\n]/.test(v);

export interface Brand {
  logoUrl: string | null;
  primaryColor: string | null;
  tagline: string | null;
}

export function brand(env: Env): Brand {
  const logo = str(env, 'BRAND_LOGO_URL');
  const color = str(env, 'BRAND_PRIMARY_COLOR');
  const tagline = str(env, 'SIGNIN_TAGLINE');
  return {
    logoUrl: validLogoUrl(logo) ? logo : null,
    primaryColor: validColor(color) ? color.toLowerCase() : null,
    tagline: validTagline(tagline) ? tagline : null,
  };
}
