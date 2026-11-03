import { ApiError, productAudience, type Role, type ServiceScope } from '@z-cloudbase/contracts';
import { bearerToken, can, classifyKey, sha256Hex, verifyAccessToken, verifyConsoleToken, type Action, type Target } from '@z-cloudbase/security';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Credential } from '../context.ts';
import { jwksResolver } from '../jwks.ts';

export const KEY_HEADER = 'X-Platform-Key';

interface EnvRow {
  id: string;
  product_id: string;
  env: Credential['env'];
  user_key_salt: string;
  status: string;
  allowed_origins: string;
}

const ENV_COLUMNS = 'pe.id, pe.product_id, pe.env, pe.user_key_salt, p.status, p.allowed_origins';

/**
 * Resolve `X-Platform-Key` into product/env context (PRD §4.1, §6.3). Looked up on every
 * request (no cache), so product disablement and key revocation take effect immediately.
 * Publishable keys from a browser must come from an allowed origin when the product lists any.
 */
export function withCredential(opts: { allow: ReadonlyArray<Credential['kind']> }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header(KEY_HEADER);
    const kind = key ? classifyKey(key) : null;
    if (!key || !kind) throw new ApiError('unauthenticated', `Missing or malformed ${KEY_HEADER}`);
    if (!opts.allow.includes(kind.kind)) throw new ApiError('forbidden', `This endpoint does not accept ${kind.kind} keys`);

    let row: (EnvRow & { cred_id?: string; scopes?: string; revoked_at?: number | null }) | null;
    if (kind.kind === 'publishable') {
      row = await c.env.DB.prepare(
        `SELECT ${ENV_COLUMNS} FROM product_environments pe JOIN products p ON p.id = pe.product_id WHERE pe.publishable_key = ?`,
      ).bind(key).first();
    } else {
      row = await c.env.DB.prepare(
        `SELECT ${ENV_COLUMNS}, sc.id AS cred_id, sc.scopes, sc.revoked_at FROM service_credentials sc
         JOIN product_environments pe ON pe.id = sc.product_env_id JOIN products p ON p.id = pe.product_id
         WHERE sc.secret_hash = ?`,
      ).bind(await sha256Hex(key)).first();
    }
    if (!row || row.revoked_at != null) throw new ApiError('unauthenticated', 'Unknown or revoked key');
    if (row.status !== 'active') throw new ApiError('product_disabled', 'Product is not active');

    if (kind.kind === 'publishable') {
      const origin = c.req.header('Origin');
      const allowed = JSON.parse(row.allowed_origins) as string[];
      if (origin && allowed.length > 0 && !allowed.includes(origin)) throw new ApiError('forbidden', 'Origin not allowed');
    }

    c.set('cred', {
      kind: kind.kind,
      productId: row.product_id,
      env: row.env,
      productEnvId: row.id,
      scopes: row.scopes ? (JSON.parse(row.scopes) as ServiceScope[]) : [],
      credentialId: row.cred_id ?? null,
      userKeySalt: row.user_key_salt,
    });
    await next();
  };
}

/** Service keys must hold `scope`; publishable keys never pass. */
export function requireScope(scope: ServiceScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cred = c.get('cred');
    if (cred.kind !== 'service' || !cred.scopes.includes(scope)) throw new ApiError('forbidden', `Requires scope ${scope}`);
    await next();
  };
}

/**
 * Verify the bearer access token for the credential's product audience and require an active
 * membership (PRD §4.2: A's token at B fails here). Must run after `withCredential`.
 * With `required: false`, a missing Authorization header yields `user = undefined`; a present
 * but invalid token is still rejected.
 */
export function withUser(opts: { required: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header) {
      if (opts.required) throw new ApiError('unauthenticated', 'Bearer access token required');
      c.set('user', undefined);
      return next();
    }
    const token = bearerToken(header);
    if (!token) throw new ApiError('invalid_token', 'Malformed Authorization header');
    const cred = c.get('cred');
    const claims = await verifyAccessToken(token, {
      issuer: c.env.ISSUER,
      audience: productAudience(cred.productEnvId),
      jwks: jwksResolver(c.env),
    });
    const m = await c.env.DB.prepare(
      `SELECT m.status, EXISTS (SELECT 1 FROM "user" u WHERE u.id = m.user_id AND u.banned = 1 AND (u.banExpires IS NULL OR u.banExpires > ?)) AS banned
       FROM product_memberships m WHERE m.user_id = ? AND m.product_id = ?`,
    )
      .bind(new Date().toISOString(), claims.sub, cred.productId)
      .first<{ status: string; banned: number }>();
    // A platform-wide ban stops access tokens issued before it (PRD §21.5.1).
    if (m?.banned) throw new ApiError('user_banned', 'This account is banned');
    if (!m || m.status !== 'active') throw new ApiError('membership_required', 'No active membership for this product');
    c.set('user', { userId: claims.sub, anon: claims.anon, sessionId: claims.sid, ...(claims.act ? { actor: claims.act.sub } : {}) });
    await next();
  };
}

/** Verify a console token and load RBAC grants (PRD §19.9). Principals without grants are rejected. */
export function withConsoleUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated', 'Bearer console token required');
    const claims = await verifyConsoleToken(token, { issuer: c.env.ISSUER, jwks: jwksResolver(c.env) });
    const { results } = await c.env.DB.prepare('SELECT role, product_id FROM team_members WHERE user_id = ?')
      .bind(claims.sub)
      .all<{ role: Role; product_id: string | null }>();
    if (results.length === 0) throw new ApiError('forbidden', 'Not a platform team member');
    c.set('admin', { userId: claims.sub, grants: results.map((r) => ({ role: r.role, productId: r.product_id })) });
    await next();
  };
}

/** Server-side RBAC check for admin routes; never rely on the UI hiding actions. */
export function authorize(c: Context<AppEnv>, action: Action, target: Target = {}): void {
  if (!can(c.get('admin').grants, action, target)) throw new ApiError('forbidden', `Not allowed: ${action}`);
}
