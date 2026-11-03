import { AsyncLocalStorage } from 'node:async_hooks';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

/**
 * System principal for platform-initiated OAuth client administration (IdentityRpc
 * `upsertProductClient`), where no end-user session exists.
 *
 * Better Auth's client/resource admin endpoints are SERVER_ONLY (never routed over HTTP) and
 * resolve their caller with `getSessionFromCtx`, which returns `ctx.context.session` when it
 * is already set — the same slot the engine fills after reading a session cookie. A before
 * hook (the engine's documented extension point) fills that slot with a synthetic platform
 * principal, but only when all of the following hold:
 * - the call is a server-side `auth.api` call (no HTTP request object),
 * - the path is one of the oauth-provider admin endpoints, and
 * - the caller opted in for this async scope via `asSystem()`.
 * Nothing is written to the session or user tables; client ownership is `referenceId =
 * 'platform'` (see `clientReference` in auth.ts), so the principal's id is never persisted.
 */
const systemScope = new AsyncLocalStorage<true>();

export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return systemScope.run(true, fn);
}

const EPOCH = new Date(0);
const SYSTEM_SESSION = {
  session: { id: 'system', userId: 'system', token: '', expiresAt: new Date(8.64e15), createdAt: EPOCH, updatedAt: EPOCH },
  user: { id: 'system', name: 'platform', email: 'system@platform.invalid', emailVerified: false, createdAt: EPOCH, updatedAt: EPOCH },
};

export function systemPrincipal() {
  return {
    id: 'cloudbase-system-principal',
    hooks: {
      before: [
        {
          matcher: (ctx) => !ctx.request && Boolean(ctx.path?.startsWith('/admin/oauth2/')) && systemScope.getStore() === true,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.context.session = SYSTEM_SESSION;
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
