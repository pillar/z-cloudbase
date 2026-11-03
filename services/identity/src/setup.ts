// Operator setup endpoints (PRD v3.0 §19.9, §20.3): first administrator and console client at install
// time, and administrator password recovery. Called by `pnpm platform:deploy` / `pnpm platform:reset-admin`
// (scripts/), never by a browser.
//
// Authorization is the SETUP_TOKEN Worker secret, sent as a bearer token. The operator scripts put
// a fresh random token before every call (`wrangler secret put` / `deploy --secrets-file`), so the
// token is never stored anywhere and holding it amounts to holding the Cloudflare account that
// deploys this worker. Without SETUP_TOKEN the routes do not exist (404).
//
// The administrator is created with the engine's own primitives (user, credential account, the
// engine's password hash), exactly like an email sign-up, but with a verified email: no mail
// provider is needed to install a deployment.
import { ApiError, newId } from '@z-cloudbase/contracts';
import { timingSafeEqual } from '@z-cloudbase/security';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './index.ts';
import { writeAudit } from './audit.ts';
import { upsertConsoleClient } from './clients.ts';
import { getAuth } from './instance.ts';
import { revokeAll } from './revoke.ts';

/** Administrator passwords: longer than the engine minimum (generated ones are 24 base62 chars). */
export const ADMIN_PASSWORD_MIN = 12;

const Password = z.string().min(ADMIN_PASSWORD_MIN).max(128);
const InstallInput = z.object({
  admin_email: z.email().max(254),
  admin_password: Password,
  console_redirect_uris: z.array(z.url()).min(1).max(20),
});
const ResetInput = z.object({
  email: z.email().max(254),
  password: Password,
  /** Remove the administrator's TOTP and backup codes (lost authenticator). */
  disable_2fa: z.boolean().default(false),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ApiError('validation_failed', 'Invalid setup request', { issues: r.error.issues.map((i) => i.path.join('.')) });
  return r.data;
}

const requireSetupToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Declared in wrangler.jsonc (string), but absent on a deployment that never ran the operator scripts.
  const expected = (c.env as { SETUP_TOKEN?: string }).SETUP_TOKEN;
  if (!expected) throw new ApiError('not_found', 'Not found');
  const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!timingSafeEqual(presented, expected)) throw new ApiError('unauthenticated', 'Invalid setup token');
  await next();
};

const ownerExists = async (db: D1Database) =>
  Boolean(await db.prepare(`SELECT 1 FROM team_members WHERE role = 'owner' LIMIT 1`).first());

export const setup = new Hono<AppEnv>();
setup.use('*', requireSetupToken);

/**
 * Idempotent install: registers (or updates the redirect URIs of) the console client, and creates
 * the first administrator with the `owner` role only while the platform has no owner. Re-running
 * it on an installed platform never creates or changes an account (`admin: "exists"`).
 */
setup.post('/install', async (c) => {
  const input = parse(InstallInput, await c.req.json().catch(() => null));
  const auth = getAuth(c.env);
  const consoleClient = await upsertConsoleClient(auth, input.console_redirect_uris);
  if (await ownerExists(c.env.DB)) return c.json({ admin: 'exists' as const, console_client: consoleClient });

  const ctx = await auth.$context;
  const email = input.admin_email.toLowerCase();
  // An existing account is never promoted by email (no account takeover through setup).
  if (await ctx.internalAdapter.findUserByEmail(email)) {
    throw new ApiError('conflict', 'An account with this email already exists; choose another administrator email');
  }
  const hash = await ctx.password.hash(input.admin_password);
  const user = await ctx.internalAdapter.createUser({ email, name: 'Administrator', emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
  await c.env.DB.prepare(
    `INSERT INTO team_members (id, user_id, role, product_id, created_by, created_at) VALUES (?, ?, 'owner', NULL, 'setup', ?)`,
  )
    .bind(newId('tm'), user.id, Date.now())
    .run();
  await writeAudit(c.env.DB, {
    actorType: 'system',
    actorId: 'setup',
    action: 'ops.owner_granted',
    targetType: 'user',
    targetId: user.id,
    requestId: c.get('requestId'),
    metadata: { source: 'install' },
  });
  return c.json({ admin: 'created' as const, user_id: user.id, console_client: consoleClient }, 201);
});

/**
 * Administrator password recovery without a mail provider: sets a new password for a platform
 * team member, signs the account out everywhere and optionally removes its second factor.
 * Ordinary (non-admin) accounts are refused: they recover through the reset-password mail.
 */
setup.post('/reset-admin', async (c) => {
  const input = parse(ResetInput, await c.req.json().catch(() => null));
  const ctx = await getAuth(c.env).$context;
  const found = await ctx.internalAdapter.findUserByEmail(input.email.toLowerCase());
  const user = found?.user as ({ id: string; deletedAt?: Date | null } | undefined);
  const member = user
    ? await c.env.DB.prepare('SELECT 1 FROM team_members WHERE user_id = ? LIMIT 1').bind(user.id).first()
    : null;
  if (!user || user.deletedAt || !member) throw new ApiError('not_found', 'No administrator with this email');

  const hash = await ctx.password.hash(input.password);
  if (await ctx.internalAdapter.findCredentialAccount(user.id)) await ctx.internalAdapter.updatePassword(user.id, hash);
  else await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
  // Sign-in by password requires a verified email when verification is enforced; an administrator
  // recovered by the operator is verified by that act.
  await ctx.internalAdapter.updateUser(user.id, { emailVerified: true });
  if (input.disable_2fa) {
    await ctx.adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: user.id }] });
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: false });
    // Passkeys count as a second factor (PRD §21.3): a lost authenticator may be a lost passkey device.
    await c.env.DB.prepare('DELETE FROM passkey WHERE userId = ?').bind(user.id).run();
  }
  await revokeAll(ctx, user.id);
  await writeAudit(c.env.DB, {
    actorType: 'system',
    actorId: 'setup',
    action: 'auth.admin_password_reset',
    targetType: 'user',
    targetId: user.id,
    requestId: c.get('requestId'),
    metadata: { disable_2fa: input.disable_2fa },
  });
  return c.json({ user_id: user.id, disabled_2fa: input.disable_2fa });
});
