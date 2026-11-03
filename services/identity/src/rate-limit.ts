import { AUTH_RATE_PER_ACCOUNT_PER_MIN, AUTH_RATE_PER_IP_PER_MIN, ApiError } from '@z-cloudbase/contracts';
import type { MiddlewareHandler } from 'hono';
import { clientIp, subjects } from './turnstile.ts';

/**
 * Credential endpoints guarded by the rate limits of PRD §19.6 (sign-in / sign-up / password
 * reset; per IP and per account). Engine paths and the server-rendered form handlers alike.
 */
export const RATE_LIMITED_PATHS = [
  '/api/auth/sign-in/*',
  '/api/auth/sign-up/*',
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  '/api/auth/send-verification-email',
  // Anonymous upgrade answers 409 for an email owned by another account (explicit conflict,
  // PRD §19.7), which reveals that the email is registered; limit it like sign-up.
  '/link/email',
  // Second-factor codes (and enrollment): the engine locks an account only during the sign-in
  // challenge, not when a signed-in session verifies a code (step-up), so limit every attempt.
  '/api/auth/two-factor/*',
  '/two-factor',
  '/two-factor/*',
  '/login',
  // Magic link requests and social sign-in starts from the sign-in page (PRD §21.3). Not `/login/*`:
  // in Hono that pattern matches `/login` as well, which would count each sign-in twice.
  '/login/magic-link',
  '/login/social',
  // Passkey assertions (PRD §21.3); the options request (GET) is limited in index.ts.
  '/api/auth/passkey/verify-authentication',
  '/register',
  '/forgot-password',
  '/reset-password',
];

/** The account an attempt targets: the submitted email (JSON or form body), if any. */
export async function submittedEmail(req: Request): Promise<string | null> {
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = await req.clone().json<{ email?: unknown }>();
      return typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    }
    if (type.includes('application/x-www-form-urlencoded')) {
      const email = new URLSearchParams(await req.clone().text()).get('email');
      return email ? email.trim().toLowerCase() : null;
    }
  } catch {
    // An unreadable body is the engine's problem (it answers 400); limit by IP only.
  }
  return null;
}

const WINDOW_MS = 60_000;

/** Counts one attempt for each key in the current one-minute window; returns the counts after it. */
async function hit(db: D1Database, keys: string[], now: number): Promise<number[]> {
  const window = now - (now % WINDOW_MS);
  const results = await db.batch(keys.map((key) =>
    db.prepare(
      `INSERT INTO auth_rate_counters (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(key, window)));
  return results.map((r) => (r.results[0] as { count: number }).count);
}

/**
 * Exact per-IP and per-account limits in front of the engine (PRD §19.6), counted in D1 fixed windows
 * (`auth_rate_counters`): one atomic upsert per key, so concurrent attempts cannot slip past the limit.
 * Exceeding either limit answers 429 `rate_limited` with Retry-After. Keys are HMACs (see `subjects`).
 * POST only, unless `anyMethod` (the `/guest` entry creates accounts on GET).
 */
export function authRateLimit(o: { anyMethod?: boolean } = {}): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!o.anyMethod && c.req.method !== 'POST') return next();
    const { ip, account } = await subjects(c.env, { ip: clientIp(c), email: await submittedEmail(c.req.raw) });
    const [ipCount, accountCount] = await hit(c.env.DB, account ? [ip, account] : [ip], Date.now());
    if (ipCount! > AUTH_RATE_PER_IP_PER_MIN) throw new ApiError('rate_limited', 'Too many attempts, try again later');
    if (accountCount !== undefined && accountCount > AUTH_RATE_PER_ACCOUNT_PER_MIN) {
      throw new ApiError('rate_limited', 'Too many attempts for this account, try again later');
    }
    await next();
  };
}
