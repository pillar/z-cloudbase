import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/**
 * Browser apps (Web SDK, console) call the issuer cross-origin: discovery and JWKS (public
 * documents, any origin) and the token / revocation / userinfo endpoints. The latter answer only
 * origins that host a registered redirect URI of some OAuth client; credentials (cookies) are
 * never allowed cross-origin, so the identity session cannot be used from another site.
 */
export const PUBLIC_METADATA_PATHS = ['/.well-known/*', '/api/auth/jwks.json'];
export const BROWSER_OAUTH_PATHS = ['/api/auth/oauth2/token', '/api/auth/oauth2/revoke', '/api/auth/oauth2/userinfo'];

export const publicMetadataCors = (): MiddlewareHandler => cors({ origin: '*', allowMethods: ['GET'], maxAge: 600 });

const ORIGINS_TTL_MS = 60_000;
let originsCache: { origins: Set<string>; at: number } | null = null;

/**
 * Origins of every registered redirect URI (engine `oauthClient.redirectUris`, a JSON array),
 * cached per isolate for 60 s so token refreshes and their preflights don't re-read every client.
 * A newly registered client's origin is therefore honoured within a minute.
 */
async function registeredOrigins(db: D1Database): Promise<Set<string>> {
  const now = Date.now();
  if (originsCache && now - originsCache.at < ORIGINS_TTL_MS) return originsCache.origins;
  const origins = await loadRegisteredOrigins(db);
  originsCache = { origins, at: now };
  return origins;
}

async function loadRegisteredOrigins(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT redirectUris FROM oauthClient').all<{ redirectUris: string | null }>();
  const origins = new Set<string>();
  for (const r of results) {
    let uris: unknown;
    try {
      uris = JSON.parse(r.redirectUris ?? '[]');
    } catch {
      continue;
    }
    for (const u of Array.isArray(uris) ? uris : []) {
      if (typeof u === 'string' && URL.canParse(u)) origins.add(new URL(u).origin);
    }
  }
  return origins;
}

export function browserOAuthCors(): MiddlewareHandler<{ Bindings: Env }> {
  return (c, next) =>
    cors({
      origin: async (origin) => (origin && (await registeredOrigins(c.env.DB)).has(origin) ? origin : null),
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })(c, next);
}
