/** Display name of this deployment (wrangler var PLATFORM_NAME), used on pages, in mail and as TOTP issuer. */
export const DEFAULT_PLATFORM_NAME = 'z-cloudbase';

export function platformName(env: Env): string {
  const name = ((env as { PLATFORM_NAME?: string }).PLATFORM_NAME ?? '').trim();
  return name || DEFAULT_PLATFORM_NAME;
}
