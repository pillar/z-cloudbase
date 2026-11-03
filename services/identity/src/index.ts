import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { errorHandler, requestId, type RequestIdVars } from '@z-cloudbase/security';
import { AUTH_BASE_PATH } from './auth.ts';
import { BROWSER_OAUTH_PATHS, PUBLIC_METADATA_PATHS, browserOAuthCors, publicMetadataCors } from './cors.ts';
import { impersonation, impersonationGuard } from './impersonation.ts';
import { getAuth } from './instance.ts';
import { RATE_LIMITED_PATHS, authRateLimit } from './rate-limit.ts';
import { turnstileGuard } from './turnstile.ts';
import { setup } from './setup.ts';
import { ui } from './ui.ts';

// Every named export of the entry module is a workerd entrypoint: export entrypoint classes only.
/** Named entrypoint bound by the api worker as `IDENTITY` (packages/contracts identity-rpc.ts). */
export { IdentityRpc } from './rpc.ts';

export type AppEnv = { Bindings: Env; Variables: RequestIdVars };

const app = new Hono<AppEnv>();
app.use(contextStorage());
app.use(requestId());
app.onError(errorHandler);

app.get('/health', (c) => c.json({ ok: true, service: 'identity' }));

// Cross-origin access for browser OIDC clients (src/cors.ts); answers preflight requests too.
for (const path of PUBLIC_METADATA_PATHS) app.use(path, publicMetadataCors());
for (const path of BROWSER_OAUTH_PATHS) app.use(path, browserOAuthCors());

// PRD §19.6 limits in front of the engine and the form handlers (POST only).
for (const path of RATE_LIMITED_PATHS) app.use(path, authRateLimit());
// The guest entry creates an anonymous account on a GET navigation (ui.ts `/guest`).
app.use('/guest', authRateLimit({ anyMethod: true }));
// Each passkey sign-in start stores a WebAuthn challenge (GET): limited per IP like a sign-in (PRD §21.3).
app.use(`${AUTH_BASE_PATH}/passkey/generate-authenticate-options`, authRateLimit({ anyMethod: true }));
// Turnstile once an account or IP failed too often (PRD §19.11); JSON callers of the engine.
app.use(`${AUTH_BASE_PATH}/*`, turnstileGuard());

// Better Auth endpoints (sign-in, sessions, /oauth2/*, /jwks.json) and OIDC discovery,
// which the oauth-provider plugin serves from its onRequest hook at the issuer root.
app.on(['GET', 'POST'], [`${AUTH_BASE_PATH}/*`, '/.well-known/*'], (c) => getAuth(c.env).handler(c.req.raw));

// Operator setup (first administrator, console client, admin password recovery); SETUP_TOKEN only.
app.route('/setup', setup);

// Support impersonation (PRD §21.5.2): banner and restrictions on the pages below, confirm / stop routes.
app.use('*', impersonationGuard());
app.route('/', impersonation);

// Login / register / consent / account pages and the anonymous Email/Password upgrade (§19.7).
app.route('/', ui);

export default app;
