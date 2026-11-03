// Deployment branding baked in at build time by `pnpm platform:deploy` (PRD §21.4). Values are validated
// here as well (the deploy script already refuses invalid ones): anything else falls back to the defaults.

/** Display name of this deployment (`VITE_PLATFORM_NAME`, set by `pnpm platform:deploy --name`). */
export const PLATFORM_NAME = (import.meta.env.VITE_PLATFORM_NAME as string | undefined)?.trim() || 'z-cloudbase';

/** https only, no whitespace, quotes, angle brackets or backslashes (same rule as the identity worker). */
export function validLogoUrl(v: string | undefined): v is string {
  if (!v || v.length > 2048 || /[\s"'<>\\`]/.test(v)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}
export const validColor = (v: string | undefined): v is string => Boolean(v && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v));

const logo = (import.meta.env.VITE_BRAND_LOGO_URL as string | undefined)?.trim();
const color = (import.meta.env.VITE_BRAND_PRIMARY_COLOR as string | undefined)?.trim();

/** `--logo-url`: shown in the sidebar and on the sign-in screen instead of the default mark. */
export const LOGO_URL: string | null = validLogoUrl(logo) ? logo : null;
/** `--primary-color`: replaces the indigo accent (shadcn `--primary` and the tokens derived from it). */
export const PRIMARY_COLOR: string | null = validColor(color) ? color : null;

/** Favicon: the logo, else a rounded square in the primary color (the default mark's background). */
export function faviconHref(): string {
  if (LOGO_URL) return LOGO_URL;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${PRIMARY_COLOR ?? '#4f46e5'}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Applies the primary color to the theme tokens (light and dark alike) and sets the favicon; called once at startup. */
export function applyBrand(root: HTMLElement = document.documentElement) {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = faviconHref();
  document.head.append(icon);
  if (!PRIMARY_COLOR) return;
  for (const token of ['--primary', '--ring', '--sidebar-primary', '--sidebar-ring', '--chart-1']) root.style.setProperty(token, PRIMARY_COLOR);
}
