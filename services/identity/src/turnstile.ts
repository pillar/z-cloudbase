// Turnstile after repeated authentication failures (PRD §19.6, §19.11).
//
// Counted as failures, per account (submitted email) and per client IP, within AUTH_FAILURE_WINDOW_S:
// - a sign-in with a wrong password or an unknown email (engine 401), JSON or the login form;
// - a password reset with an invalid or expired reset token (engine 400; per IP only, no email).
// Requesting a reset link is NOT counted: its answer is identical for known and unknown addresses,
// so it is no failure the client could observe. Once either counter reaches TURNSTILE_AFTER_FAILURES,
// sign-in, sign-up, both password-reset steps and the anonymous upgrade (/link/email) need a valid
// Turnstile token: the `cf-turnstile-response` form field (set by the widget) or, for JSON callers,
// the `cf-turnstile-response` header. A successful sign-in clears the account counter (not the IP's).
// Only `acct:` / `ip:` + HMAC(AUTH_SECRET, value) is stored, never an email or IP address.
import { AUTH_FAILURE_WINDOW_S, ApiError, TURNSTILE_AFTER_FAILURES } from '@z-cloudbase/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { submittedEmail } from './rate-limit.ts';

export const TURNSTILE_FIELD = 'cf-turnstile-response';
/** Response token produced by Cloudflare's Turnstile testing site keys (accepted by the testing secret keys). */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifier {
  verify(token: string, ip: string): Promise<boolean>;
}

/** Production: Cloudflare siteverify with the widget's secret key (remote-unverified in the POC). */
export function siteverifyVerifier(secret: string, fetcher: typeof fetch = fetch): TurnstileVerifier {
  return {
    async verify(token, ip) {
      const body = new FormData();
      body.set('secret', secret);
      body.set('response', token);
      body.set('remoteip', ip);
      const res = await fetcher(SITEVERIFY_URL, { method: 'POST', body });
      if (!res.ok) throw new ApiError('unavailable', 'Turnstile verification is unavailable, try again later');
      return (await res.json<{ success?: unknown }>()).success === true;
    },
  };
}

/** Local development and tests: only the testing keys' dummy token passes; no network access. */
export const localVerifier: TurnstileVerifier = {
  async verify(token) {
    return token === TURNSTILE_DUMMY_TOKEN;
  },
};

/**
 * Turnstile is optional for a self-hosted deployment: without TURNSTILE_SECRET_KEY no challenge is
 * ever due (the per-IP / per-account rate limits of rate-limit.ts still apply). Local development
 * always runs it with Cloudflare's testing keys.
 */
export function turnstileEnabled(env: Env): boolean {
  return (env.DEPLOY_ENV as string) === 'local' || Boolean(env.TURNSTILE_SECRET_KEY);
}

export function turnstileVerifier(env: Env): TurnstileVerifier {
  if ((env.DEPLOY_ENV as string) === 'local') return localVerifier;
  if (!env.TURNSTILE_SECRET_KEY) throw new Error('TURNSTILE_SECRET_KEY is not configured for this deployment');
  return siteverifyVerifier(env.TURNSTILE_SECRET_KEY);
}

/** One guarded attempt: who it targets and the token it carries, if any. */
export interface Attempt {
  ip: string;
  /** Normalized (trimmed, lowercase) email, when the request names an account. */
  email: string | null;
  token: string | null;
}

export const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown';
export const normalizeEmail = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Storage keys for an attempt's IP and account: `ip:` / `acct:` + HMAC, never the raw value (also used by rate-limit.ts). */
export async function subjects(env: Env, a: Pick<Attempt, 'ip' | 'email'>): Promise<{ ip: string; account: string | null }> {
  return {
    ip: `ip:${await hmacHex(env.AUTH_SECRET, a.ip)}`,
    account: a.email ? `acct:${await hmacHex(env.AUTH_SECRET, a.email)}` : null,
  };
}

const windowStart = () => Date.now() - AUTH_FAILURE_WINDOW_S * 1000;

/** True when the IP or the account reached TURNSTILE_AFTER_FAILURES failures within the window. */
export async function turnstileRequired(env: Env, a: Pick<Attempt, 'ip' | 'email'>): Promise<boolean> {
  if (!turnstileEnabled(env)) return false;
  const s = await subjects(env, a);
  const row = await env.DB.prepare(
    `SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM auth_failures WHERE subject IN (?, ?) AND occurred_at > ? GROUP BY subject)`,
  )
    .bind(s.ip, s.account ?? s.ip, windowStart())
    .first<{ n: number | null }>();
  return (row?.n ?? 0) >= TURNSTILE_AFTER_FAILURES;
}

/** Whether the attempt may proceed: no challenge is due, or it carries a token the verifier accepts. */
export async function passesTurnstile(env: Env, a: Attempt): Promise<boolean> {
  if (!(await turnstileRequired(env, a))) return true;
  return Boolean(a.token) && (await turnstileVerifier(env).verify(a.token!, a.ip));
}

export const turnstileError = (env: Env) =>
  new ApiError('forbidden', 'Complete the Turnstile challenge to continue', { reason: 'turnstile_required', site_key: env.TURNSTILE_SITE_KEY });

/** Count a failure for the IP and the account; a success clears the account's counter. */
export async function recordOutcome(env: Env, a: Attempt, outcome: 'failure' | 'success' | null): Promise<void> {
  if (!outcome) return;
  const s = await subjects(env, a);
  if (outcome === 'success') {
    if (s.account) await env.DB.prepare('DELETE FROM auth_failures WHERE subject = ?').bind(s.account).run();
    return;
  }
  const now = Date.now();
  const keys = s.account ? [s.ip, s.account] : [s.ip];
  await env.DB.batch(
    keys.flatMap((k) => [
      env.DB.prepare('DELETE FROM auth_failures WHERE subject = ? AND occurred_at <= ?').bind(k, windowStart()),
      env.DB.prepare('INSERT INTO auth_failures (subject, occurred_at) VALUES (?, ?)').bind(k, now),
    ]),
  );
}

/** Engine answers that count: a rejected sign-in, a rejected reset token. */
export const signInOutcome = (status: number) => (status === 401 ? 'failure' : status === 200 ? 'success' : null);
export const resetOutcome = (status: number) => (status === 400 ? 'failure' : null);

/** Guarded engine endpoints (JSON callers); the server-rendered forms guard themselves in ui.ts. */
const ENGINE_PATHS: Record<string, ((status: number) => 'failure' | 'success' | null) | null> = {
  '/api/auth/sign-in/email': signInOutcome,
  '/api/auth/sign-up/email': null,
  '/api/auth/request-password-reset': null,
  '/api/auth/reset-password': resetOutcome,
};

/** In front of the engine: 403 `forbidden` (reason `turnstile_required`) when a challenge is due and not passed. */
export function turnstileGuard(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // The engine's router ignores a trailing slash; so must the lookup.
    const path = c.req.path.replace(/\/+$/, '');
    if (c.req.method !== 'POST' || !(path in ENGINE_PATHS)) return next();
    const attempt: Attempt = { ip: clientIp(c), email: await submittedEmail(c.req.raw), token: c.req.header(TURNSTILE_FIELD) ?? null };
    if (!(await passesTurnstile(c.env, attempt))) throw turnstileError(c.env);
    await next();
    await recordOutcome(c.env, attempt, ENGINE_PATHS[path]?.(c.res.status) ?? null);
  };
}

/** The widget; it adds the `cf-turnstile-response` field to the enclosing form. */
export const turnstileWidget = (siteKey: string) =>
  html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile" data-sitekey="${siteKey}"></div>`;
