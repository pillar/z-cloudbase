import { createExecutionContext } from 'cloudflare:test';
import { exports, env } from 'cloudflare:workers';
import app from '../src/index.ts';
import { getAuth } from '../src/instance.ts';

export const ORIGIN = env.ISSUER;

/** Minimal cookie jar: keeps name=value pairs from Set-Cookie across requests. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Env the requests of `call()` go to instead of the worker's own (see `useEnv`). */
let overridden: Env | null = null;

/**
 * Send every following `call()` to the worker with these deployment var overrides (e.g.
 * REQUIRE_ADMIN_2FA), or back to the configured env with `null`. One env object per call, so the
 * engine instance (cached per env object) is built with the overrides.
 */
export function useEnv(vars: (Partial<Record<keyof Env, string>> & Record<string, string>) | null) {
  overridden = vars ? ({ ...env, ...vars } as Env) : null;
}

/**
 * Request against the identity worker, carrying (and updating) the cookie jar. Each request
 * gets a distinct client IP unless a test pins `cf-connecting-ip` (auth limits are per IP).
 */
export async function call(path: string, init: RequestInit & { jar?: CookieJar; json?: unknown; form?: Record<string, string> } = {}) {
  const { jar, json, form, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('origin')) headers.set('origin', ORIGIN);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', `10.${[...crypto.getRandomValues(new Uint8Array(3))].join('.')}`);
  if (jar && jar.cookies.size) headers.set('cookie', jar.header());
  if (json !== undefined) headers.set('content-type', 'application/json');
  if (form !== undefined) headers.set('content-type', 'application/x-www-form-urlencoded');
  const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
  const body = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : rest.body;
  const reqInit: RequestInit = {
    ...rest,
    headers,
    redirect: 'manual',
    ...(body !== undefined && body !== null ? { method: rest.method ?? 'POST', body } : {}),
  };
  const res = overridden
    ? await app.fetch(new Request(url, reqInit), overridden, createExecutionContext())
    : await exports.default.fetch(url, reqInit);
  jar?.store(res);
  return res;
}

export const auth = () => getAuth(env);

let n = 0;
export const uniqueEmail = (tag = 'user') => `${tag}-${Date.now()}-${++n}-${crypto.randomUUID().slice(0, 8)}@example.test`;
export const PASSWORD = 'correct horse battery staple';

/** Email sign-in; puts the identity session cookie into the jar. */
export async function signIn(jar: CookieJar, email: string, password = PASSWORD) {
  const res = await call('/api/auth/sign-in/email', { jar, json: { email, password } });
  if (res.status !== 200) throw new Error(`sign-in failed ${res.status}: ${await res.text()}`);
  return (await res.json<{ user: { id: string } }>()).user.id;
}

/**
 * Register a new Email/Password user and sign in with the jar. Sign-up itself never signs in
 * (anti-enumeration: `autoSignIn: false`), so this is two requests like in a browser.
 */
export async function signUp(jar: CookieJar, email = uniqueEmail()) {
  const res = await call('/api/auth/sign-up/email', { jar, json: { email, password: PASSWORD, name: 'Test' } });
  if (res.status !== 200) throw new Error(`sign-up failed ${res.status}: ${await res.text()}`);
  const userId = await signIn(jar, email);
  return { email, userId };
}

export async function jarHeaders(jar: CookieJar) {
  return new Headers({ cookie: jar.header(), origin: ORIGIN });
}

/** Platform product row (PRD §7); product admission reads status and visibility from it. */
export async function seedProduct(
  id: string,
  opts: { visibility?: 'open' | 'restricted'; status?: 'active' | 'disabled' | 'archived'; name?: string } = {},
) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO products (id, name, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, visibility = excluded.visibility`,
  )
    .bind(id, opts.name ?? id, opts.status ?? 'active', opts.visibility ?? 'open', now, now)
    .run();
}

export async function setMembership(userId: string, productId: string, status: 'active' | 'suspended' | 'revoked') {
  await env.DB.prepare(
    `INSERT INTO product_memberships (user_id, product_id, status, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, product_id) DO UPDATE SET status = excluded.status`,
  )
    .bind(userId, productId, status, Date.now())
    .run();
}

export async function membership(userId: string, productId: string) {
  return env.DB.prepare('SELECT status, joined_at, last_seen_at FROM product_memberships WHERE user_id = ? AND product_id = ?')
    .bind(userId, productId)
    .first<{ status: string; joined_at: number; last_seen_at: number | null }>();
}

/** Mail written by the local outbox adapter, newest first. */
export async function outbox(to: string) {
  const { results } = await env.DB.prepare('SELECT template, payload FROM email_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC')
    .bind(to)
    .all<{ template: string; payload: string }>();
  return results.map((r) => ({ template: r.template, payload: JSON.parse(r.payload) as Record<string, string> }));
}

export async function auditRows(action: string, targetId: string) {
  const { results } = await env.DB.prepare('SELECT actor_type, actor_id, product_id, env, metadata FROM audit_log WHERE action = ? AND target_id = ?')
    .bind(action, targetId)
    .all<{ actor_type: string; actor_id: string; product_id: string | null; env: string | null; metadata: string }>();
  return results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) as Record<string, unknown> }));
}

/**
 * The limits count in fixed one-minute windows (PRD §19.6): a burst that straddles a window edge is
 * legitimately counted in two windows. Start window-sensitive tests well inside a window (the wait can
 * take up to `marginMs`, so such tests need a timeout above vitest's 5 s default).
 */
export async function awayFromWindowEdge(marginMs = 10_000) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < marginMs) await new Promise((r) => setTimeout(r, left + 50));
}
