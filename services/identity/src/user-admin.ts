// Platform user management on the auth engine (PRD §21.5): platform-wide bans and support impersonation.
//
// Better Auth's admin plugin is deliberately not used: its endpoints authorize through `user.role` /
// `adminUserIds`, a second administrator model next to the platform's `team_members` RBAC, and its
// impersonation cannot express the platform's rules (owner + fresh TOTP, reason, no team members, a
// fixed lifetime, the RFC 8693 `act` claim). This plugin reuses the same engine primitives instead:
// the admin plugin's field names (`banned`, `banReason`, `banExpires`, `session.impersonatedBy`), the
// session-creation hook as the single place where every sign-in method creates a session,
// `internalAdapter.createSession`, the session / signed cookies, and the OAuth provider's claim extension.
import {
  CONSOLE_CLIENT_ID, IMPERSONATION_MAX_S, REAUTH_WINDOW_S, type ImpersonationEndReason,
} from '@z-cloudbase/contracts';
import { extendOAuthProvider, getOAuthProviderApi } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { deleteSessionCookie, expireCookie, setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { auditStatement, writeAudit } from './audit.ts';
import { emitUpgraded } from './webhooks.ts';

/** Ban in effect now: flagged and not past its (optional) end. */
export function isBanned(u: { banned?: boolean | number | null; banExpires?: Date | string | null }, now = Date.now()): boolean {
  if (!u.banned) return false;
  return !u.banExpires || new Date(u.banExpires).getTime() > now;
}

export function bannedMessage(banExpires: Date | string | null | undefined): string {
  return banExpires
    ? `This account has been banned until ${new Date(banExpires).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
    : 'This account has been banned.';
}

/**
 * Engine endpoints an impersonation session may use (PRD §21.5.2): session lookup, product
 * authorization and consent, the token / userinfo / JWKS endpoints, signing out and ending the
 * impersonation. Everything else — password, email, linked accounts, TOTP, passkeys, sessions, account
 * deletion, signing in again, starting another impersonation — is refused, including endpoints added later.
 */
export const IMPERSONATION_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/get-session', '/sign-out', '/list-accounts', '/ok', '/error',
  '/oauth2/authorize', '/oauth2/continue', '/oauth2/consent', '/oauth2/token', '/oauth2/userinfo', '/oauth2/introspect',
  '/oauth2/revoke', '/oauth2/end-session', '/oauth2/public-client', '/oauth2/public-client-prelogin',
  '/jwks', '/jwks.json', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server',
  '/impersonation/stop',
]);

interface ImpersonationRow {
  id: string;
  actor_id: string;
  target_id: string;
  reason: string;
  status: 'pending' | 'active' | 'ended' | 'cancelled';
  request_expires_at: number;
  session_id: string | null;
  expires_at: number | null;
}

/** The active, unexpired impersonation bound to an engine session id. */
export async function activeImpersonation(db: D1Database, sessionId: string, now = Date.now()): Promise<ImpersonationRow | null> {
  return db
    .prepare(`SELECT * FROM impersonations WHERE session_id = ? AND status = 'active' AND expires_at > ?`)
    .bind(sessionId, now)
    .first<ImpersonationRow>();
}

/** Mark impersonations ended (by session or by target) and audit each; returns the ended rows. */
export async function endImpersonations(
  db: D1Database,
  where: { sessionId: string } | { targetId: string },
  reason: ImpersonationEndReason,
  actor: { type: 'user' | 'system'; id: string },
): Promise<ImpersonationRow[]> {
  const now = Date.now();
  const [col, value] = 'sessionId' in where ? ['session_id', where.sessionId] : ['target_id', where.targetId];
  const { results } = await db
    .prepare(`UPDATE impersonations SET status = 'ended', ended_at = ?, end_reason = ? WHERE ${col} = ? AND status = 'active' RETURNING *`)
    .bind(now, reason, value)
    .all<ImpersonationRow>();
  if (results.length > 0) {
    await db.batch(results.map((r) => auditStatement(db, {
      actorType: actor.type, actorId: actor.id, action: 'user.impersonation.stop', targetType: 'user', targetId: r.target_id,
      metadata: { impersonation_id: r.id, actor_id: r.actor_id, end_reason: reason },
    })));
  }
  return results;
}

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

function oauthOptions(ctx: HookCtx) {
  return (ctx.context.getPlugin('oauth-provider') as { options: Parameters<typeof getOAuthProviderApi>[1] }).options;
}

const ADMIN_SESSION_COOKIE = 'impersonator_session';

export function userAdmin(deps: { db: D1Database }) {
  const { db } = deps;

  /** RFC 8693 `act` for tokens issued from an active impersonation session (access and id tokens). */
  const actClaim = async ({ sessionId }: { sessionId?: string }) => {
    if (!sessionId) return {};
    const row = await activeImpersonation(db, sessionId);
    return row ? { act: { sub: row.actor_id } } : {};
  };

  return {
    id: 'z-cloudbase-user-admin',
    schema: {
      user: {
        fields: {
          banned: { type: 'boolean', required: false, defaultValue: false, input: false },
          banReason: { type: 'string', required: false, input: false, returned: false },
          banExpires: { type: 'date', required: false, input: false },
        },
      },
      session: {
        fields: { impersonatedBy: { type: 'string', required: false, input: false } },
      },
    },
    init: (ctx) => {
      extendOAuthProvider(ctx, { claims: { accessToken: actClaim, idToken: actClaim } });
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                // The one layer every sign-in method goes through (password, social, two-factor,
                // passkey, magic link, ...): a banned user never gets a session (PRD §21.5.1).
                async before(session, hookCtx) {
                  const user = hookCtx
                    ? await hookCtx.context.internalAdapter.findUserById(session.userId)
                    : await db.prepare('SELECT banned, banExpires FROM "user" WHERE id = ?').bind(session.userId).first();
                  const u = user as { banned?: boolean | null; banExpires?: Date | string | null } | null;
                  if (u && isBanned(u)) {
                    throw new APIError('FORBIDDEN', { code: 'BANNED_USER', message: bannedMessage(u.banExpires) });
                  }
                },
              },
            },
            account: {
              create: {
                // Registered before account-policy.ts, which flips isAnonymous right after: a still
                // anonymous user receiving a credential is the guest upgrade (PRD §19.7, §21.6).
                async after(account, hookCtx) {
                  if (!hookCtx) return;
                  const user = await hookCtx.context.internalAdapter.findUserById(account.userId);
                  if (!(user as { isAnonymous?: boolean | null } | null)?.isAnonymous) return;
                  await emitUpgraded(db, account.userId, account.providerId);
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => !IMPERSONATION_ALLOWED_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
              throw new APIError('FORBIDDEN', {
                code: 'IMPERSONATION_RESTRICTED',
                message: 'Not available during a support session (impersonation)',
              });
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!(session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) return;
            const params: Record<string, unknown> = { ...(ctx.body ?? {}), ...(ctx.query ?? {}) };
            // Never the console, and only while the impersonation is active.
            const active = await activeImpersonation(db, session!.session.id);
            if (params.client_id === CONSOLE_CLIENT_ID || !active) {
              throw new APIError('BAD_REQUEST', { error: 'access_denied', error_description: 'not available during a support session' });
            }
          }),
        },
        {
          // Codes and refresh tokens from an impersonation session work only while it is active (PRD §21.5.2).
          matcher: (ctx) => ctx.path === '/oauth2/token',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const api = getOAuthProviderApi(ctx, oauthOptions(ctx));
            let sessionId: string | null | undefined;
            if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
              const row = await ctx.context.adapter.findOne<{ sessionId: string | null }>({
                model: 'oauthRefreshToken',
                where: [{ field: 'token', value: await api.hashToken(body.refresh_token, 'refresh_token') }],
              });
              sessionId = row?.sessionId;
            } else if (body.grant_type === 'authorization_code' && typeof body.code === 'string') {
              const stored = await ctx.context.internalAdapter.findVerificationValue(await api.hashToken(body.code, 'authorization_code'));
              try {
                sessionId = stored ? (JSON.parse(stored.value) as { sessionId?: string }).sessionId : undefined;
              } catch {
                sessionId = undefined;
              }
            }
            if (!sessionId) return;
            const imp = await db.prepare('SELECT status, expires_at FROM impersonations WHERE session_id = ?')
              .bind(sessionId).first<{ status: string; expires_at: number | null }>();
            if (imp && !(imp.status === 'active' && (imp.expires_at ?? 0) > Date.now())) {
              throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'the support session has ended' });
            }
          }),
        },
        {
          // Signing out of an impersonation session ends the impersonation (the session delete revokes its tokens).
          matcher: (ctx) => ctx.path === '/sign-out',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            const actor = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;
            if (!actor) return;
            await endImpersonations(db, { sessionId: session!.session.id }, 'signed_out', { type: 'user', id: actor });
          }),
        },
      ],
    },
    endpoints: {
      /**
       * Start a confirmed impersonation for the signed-in owner (called by impersonation.ts after the
       * TOTP step-up, never routed over HTTP). Re-checks every rule; the browser's session cookie becomes
       * the impersonation session and the owner's own session token goes into a signed cookie.
       */
      startImpersonation: createAuthEndpoint(
        '/impersonation/start',
        { method: 'POST', body: z.object({ id: z.string().startsWith('imp_') }), metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx);
          if (!session) throw new APIError('UNAUTHORIZED', { message: 'Sign in first' });
          const actor = session.user as typeof session.user & { twoFactorEnabled?: boolean | null };
          const now = Date.now();
          const row = await db.prepare(`SELECT * FROM impersonations WHERE id = ? AND actor_id = ? AND status = 'pending' AND request_expires_at > ?`)
            .bind(ctx.body.id, actor.id, now).first<ImpersonationRow>();
          if (!row) throw new APIError('NOT_FOUND', { code: 'IMPERSONATION_NOT_FOUND', message: 'This support session request is unknown, expired or already used' });
          const owner = await db.prepare(`SELECT 1 AS x FROM team_members WHERE user_id = ? AND role = 'owner'`).bind(actor.id).first();
          if (!owner) throw new APIError('FORBIDDEN', { message: 'Only platform owners can start a support session' });
          if (!actor.twoFactorEnabled) throw new APIError('FORBIDDEN', { code: 'MFA_REQUIRED', message: 'Turn on two-factor authentication first' });
          const verifiedAt = (session.session as { twoFactorVerifiedAt?: Date | string | null }).twoFactorVerifiedAt;
          if (!verifiedAt || now - new Date(verifiedAt).getTime() > REAUTH_WINDOW_S * 1000) {
            throw new APIError('FORBIDDEN', { code: 'MFA_NOT_FRESH', message: 'Enter a current code from your authenticator app' });
          }
          const target = await ctx.context.internalAdapter.findUserById(row.target_id) as
            (Record<string, unknown> & { id: string; deletedAt?: Date | null; banned?: boolean | null; banExpires?: Date | null }) | null;
          const member = await db.prepare('SELECT 1 AS x FROM team_members WHERE user_id = ?').bind(row.target_id).first();
          if (!target || target.deletedAt || member || isBanned(target) || target.id === actor.id) {
            throw new APIError('CONFLICT', { code: 'IMPERSONATION_TARGET_NOT_ALLOWED', message: 'This user cannot be impersonated' });
          }
          const expiresAt = now + IMPERSONATION_MAX_S * 1000;
          const created = await ctx.context.internalAdapter.createSession(
            target.id, true, { impersonatedBy: actor.id, expiresAt: new Date(expiresAt) }, true,
          );
          const claimed = await db.prepare(
            `UPDATE impersonations SET status = 'active', session_id = ?, started_at = ?, expires_at = ? WHERE id = ? AND status = 'pending'`,
          ).bind(created.id, now, expiresAt, row.id).run();
          if (claimed.meta.changes !== 1) {
            await ctx.context.internalAdapter.deleteSession(created.token);
            throw new APIError('CONFLICT', { message: 'This support session request was already used' });
          }
          await writeAudit(db, {
            actorType: 'user', actorId: actor.id, action: 'user.impersonation.start', targetType: 'user', targetId: target.id,
            metadata: { impersonation_id: row.id, reason: row.reason, expires_at: new Date(expiresAt).toISOString() },
          });
          const adminCookie = ctx.context.createAuthCookie(ADMIN_SESSION_COOKIE);
          await ctx.setSignedCookie(adminCookie.name, session.session.token, ctx.context.secret, { ...adminCookie.attributes, maxAge: IMPERSONATION_MAX_S });
          // dontRememberMe: the engine then never extends this session (its lifetime stays fixed).
          await setSessionCookie(ctx, { session: created, user: target as never }, true);
          return ctx.json({ target_id: target.id, expires_at: new Date(expiresAt).toISOString() });
        },
      ),
      /** End the current impersonation and restore the owner's own session when it is still valid. */
      stopImpersonation: createAuthEndpoint('/impersonation/stop', { method: 'POST', metadata: { SERVER_ONLY: true } }, async (ctx) => {
        const session = await getSessionFromCtx(ctx);
        const actorId = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;
        if (!session || !actorId) throw new APIError('BAD_REQUEST', { message: 'No support session to end' });
        await endImpersonations(db, { sessionId: session.session.id }, 'stopped', { type: 'user', id: actorId });
        await ctx.context.internalAdapter.deleteSession(session.session.token);
        const adminCookie = ctx.context.createAuthCookie(ADMIN_SESSION_COOKIE);
        const token = await ctx.getSignedCookie(adminCookie.name, ctx.context.secret);
        expireCookie(ctx, adminCookie);
        const own = token ? await ctx.context.internalAdapter.findSession(token) : null;
        if (own && own.session.userId === actorId && new Date(own.session.expiresAt).getTime() > Date.now()) {
          await setSessionCookie(ctx, own, false);
          return ctx.json({ restored: true });
        }
        deleteSessionCookie(ctx);
        return ctx.json({ restored: false });
      }),
    },
  } satisfies BetterAuthPlugin;
}
