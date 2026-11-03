// Platform policy around the engine's OAuth provider (PRD §4.2, §6.2, §19.4). Better Auth keeps
// the whole protocol; this plugin only adds product admission (products + product_memberships),
// membership bookkeeping and the refresh-token reuse audit through engine hooks.
import { CONSOLE_CLIENT_ID, parseClientId, type Environment } from '@z-cloudbase/contracts';
import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { writeAudit } from './audit.ts';
import { consoleMfaStep, hasPasskey } from './mfa-policy.ts';
import { deliverSoon, envJoinStatements } from './webhooks.ts';

type Decision = { allow: true } | { allow: false; reason: string };

/**
 * Product admission (PRD §4.2, §6.2 step 3): the product must exist and be `active`; an
 * active membership always passes; `open` products admit newcomers at authorization time
 * (`join`), `restricted` ones only with an existing active membership; suspended/revoked
 * memberships never pass. Refresh and code exchange (`join: false`) need an active membership.
 */
export async function productAccess(db: D1Database, productId: string, userId: string, join: boolean): Promise<Decision> {
  const row = await db
    .prepare(
      `SELECT p.status, p.visibility, m.status AS membership,
         EXISTS (SELECT 1 FROM "user" u WHERE u.id = ? AND u.banned = 1 AND (u.banExpires IS NULL OR u.banExpires > ?)) AS banned
       FROM products p LEFT JOIN product_memberships m ON m.product_id = p.id AND m.user_id = ? WHERE p.id = ?`,
    )
    .bind(userId, new Date().toISOString(), userId, productId)
    .first<{ status: string; visibility: string; membership: string | null; banned: number }>();
  if (!row || row.status !== 'active') return { allow: false, reason: 'product is not available' };
  // Platform-wide ban (PRD §21.5.1): no authorization, code exchange or refresh for any product.
  if (row.banned) return { allow: false, reason: 'user is banned' };
  if (row.membership === 'active') return { allow: true };
  if (row.membership) return { allow: false, reason: `membership is ${row.membership}` };
  if (join && row.visibility === 'open') return { allow: true };
  return { allow: false, reason: 'membership required' };
}

/**
 * Called once an authorization code was issued: join an open product, or refresh last_seen_at; record the
 * first authorization in this environment and its `user.joined` webhook event in the same batch (PRD §21.6).
 */
export async function recordAuthorization(db: D1Database, productId: string, env: Environment, userId: string): Promise<void> {
  const now = Date.now();
  const anon = await db.prepare('SELECT isAnonymous FROM "user" WHERE id = ?').bind(userId).first<{ isAnonymous: number | null }>();
  const joined = envJoinStatements(db, { productId, env, userId, anonymous: Boolean(anon?.isAnonymous), now });
  await db.batch([
    db.prepare(`UPDATE product_memberships SET last_seen_at = ? WHERE user_id = ? AND product_id = ? AND status = 'active'`)
      .bind(now, userId, productId),
    db.prepare(
      `INSERT OR IGNORE INTO product_memberships (user_id, product_id, status, joined_at, last_seen_at)
       SELECT ?, id, 'active', ?, ? FROM products WHERE id = ? AND status = 'active' AND visibility = 'open'`,
    ).bind(userId, now, now, productId),
    ...joined.statements,
  ]);
  deliverSoon(db, [joined.messageId]);
}

function oauthOptions(ctx: { context: { getPlugin(id: string): unknown } }) {
  return (ctx.context.getPlugin('oauth-provider') as { options: Parameters<typeof getOAuthProviderApi>[1] }).options;
}

const invalidGrant = (description: string) =>
  new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: description });

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** Send the browser to `url` the way the engine answers authorize: JSON for fetch / resumed sign-in, else a 302. */
function redirectTo(ctx: HookCtx, url: string) {
  const wantsJson = ctx.request?.headers.get('sec-fetch-mode') === 'cors' || ctx.headers?.get('accept')?.includes('application/json');
  if (wantsJson) return { redirect: true, url };
  throw ctx.redirect(url);
}

/**
 * The authorization request to resume after the MFA pages, from the query only: when the engine
 * resumes an authorization after sign-in, `ctx.body` is the sign-in body (email, password).
 * String parameters only; `prompt=login` is dropped like the engine does after a fresh sign-in,
 * otherwise the resume would loop to /login.
 */
function authorizeAgain(query: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    for (const item of Array.isArray(v) ? v : [v]) if (typeof item === 'string') q.append(k, item);
  }
  if (q.get('prompt') === 'login') q.delete('prompt');
  return `/api/auth/oauth2/authorize?${q}`;
}

export function oauthPolicy(deps: { db: D1Database; issuer: string; requireAdmin2fa: boolean }) {
  const { db } = deps;
  return {
    id: 'z-cloudbase-oauth-policy',
    init: () => ({
      options: {
        databaseHooks: {
          verification: {
            create: {
              // The engine stores an issued authorization code as a verification value.
              async after(verification) {
                let value: { type?: string; userId?: string; query?: { client_id?: string } };
                try {
                  value = JSON.parse(verification.value);
                } catch {
                  return;
                }
                const client = value.type === 'authorization_code' ? parseClientId(value.query?.client_id ?? '') : null;
                if (client && value.userId) await recordAuthorization(db, client.productId, client.env, value.userId);
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          // Every authorization (direct, resumed after sign-in, after consent) is dispatched
          // through the engine's hook pipeline with this path.
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            const params: Record<string, unknown> = { ...(ctx.body ?? {}), ...(ctx.query ?? {}) };
            const clientIdValue = typeof params.client_id === 'string' ? params.client_id : '';
            if (clientIdValue === CONSOLE_CLIENT_ID) {
              // Admin MFA (PRD §19.11): an admin with TOTP must have passed it in this identity session;
              // enrollment is forced only with REQUIRE_ADMIN_2FA. The identity-domain MFA pages resume
              // this authorization afterwards.
              const session = await getSessionFromCtx(ctx);
              if (!session) return; // the engine sends the user to /login; this hook runs again on resume
              const step = consoleMfaStep(session, deps.requireAdmin2fa, deps.requireAdmin2fa && (await hasPasskey(db, session.user.id)));
              if (!step) return;
              const page = step === 'setup' ? '/two-factor/setup' : '/two-factor';
              return redirectTo(ctx, `${deps.issuer}${page}?${new URLSearchParams({ return: authorizeAgain(ctx.query ?? {}) })}`);
            }
            const client = parseClientId(clientIdValue);
            if (!client) return; // unknown clients: engine rules only
            const session = await getSessionFromCtx(ctx);
            if (!session) return; // the engine sends the user to /login; this hook runs again on resume
            const decision = await productAccess(db, client.productId, session.user.id, true);
            if (decision.allow) return;

            // Deliver `access_denied` to the client only if its redirect_uri is registered verbatim.
            const registered = await getOAuthProviderApi(ctx, oauthOptions(ctx)).getClient(clientIdValue);
            const redirectUri = typeof params.redirect_uri === 'string' ? params.redirect_uri : '';
            if (!registered || registered.disabled || !registered.redirectUris?.includes(redirectUri)) {
              throw new APIError('BAD_REQUEST', { error: 'access_denied', error_description: decision.reason });
            }
            const url = new URL(redirectUri);
            url.searchParams.set('error', 'access_denied');
            url.searchParams.set('error_description', decision.reason);
            if (typeof params.state === 'string') url.searchParams.set('state', params.state);
            url.searchParams.set('iss', deps.issuer);
            return redirectTo(ctx, url.toString());
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/oauth2/token',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const api = getOAuthProviderApi(ctx, oauthOptions(ctx));

            if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
              const row = await ctx.context.adapter.findOne<{ clientId: string; userId: string; revoked: Date | null }>({
                model: 'oauthRefreshToken',
                where: [{ field: 'token', value: await api.hashToken(body.refresh_token, 'refresh_token') }],
              });
              if (!row) return; // unknown token: the engine answers invalid_grant
              const client = parseClientId(row.clientId);
              if (row.revoked) {
                // Replay of a rotated token. The engine rejects it and drops the user's refresh
                // tokens for this client (PRD §19.4); the platform records the security event.
                await writeAudit(db, {
                  actorType: 'system',
                  actorId: 'identity',
                  action: 'auth.refresh_token_reuse',
                  productId: client?.productId,
                  env: client?.env,
                  targetType: 'user',
                  targetId: row.userId,
                  metadata: { client_id: row.clientId },
                });
                return;
              }
              if (!client) return;
              const decision = await productAccess(db, client.productId, row.userId, false);
              if (!decision.allow) throw invalidGrant(decision.reason);
              await db.prepare('UPDATE product_memberships SET last_seen_at = ? WHERE user_id = ? AND product_id = ?')
                .bind(Date.now(), row.userId, client.productId)
                .run();
              return;
            }

            if (body.grant_type === 'authorization_code' && typeof body.code === 'string') {
              // A code issued before the product was disabled or the membership revoked.
              const stored = await ctx.context.internalAdapter.findVerificationValue(
                await api.hashToken(body.code, 'authorization_code'),
              );
              if (!stored) return;
              const value = JSON.parse(stored.value) as { userId?: string; query?: { client_id?: string } };
              const client = parseClientId(value.query?.client_id ?? '');
              if (!client || !value.userId) return;
              const decision = await productAccess(db, client.productId, value.userId, false);
              if (!decision.allow) throw invalidGrant(decision.reason);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
