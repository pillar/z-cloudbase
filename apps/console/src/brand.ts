/** Display name of this deployment, baked in at build time (`VITE_PLATFORM_NAME`, set by `pnpm platform:deploy --name`). */
export const PLATFORM_NAME = (import.meta.env.VITE_PLATFORM_NAME as string | undefined)?.trim() || 'CloudBase';
