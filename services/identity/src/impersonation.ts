// Support impersonation on the identity domain (PRD §21.5.2): the owner's confirmation page (TOTP step-up,
// then the engine endpoint in user-admin.ts), the stop button, and a guard that renders a banner on every
// identity page and refuses the account pages' state changes while the browser holds an impersonation
// session. Engine endpoints are restricted by the plugin itself (IMPERSONATION_ALLOWED_PATHS).
import { ApiError, IMPERSONATION_MAX_S } from '@z-cloudbase/contracts';
import type { RequestIdVars } from '@z-cloudbase/security';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AUTH_BASE_PATH } from './auth.ts';
import { getAuth } from './instance.ts';
import { platformName } from './platform.ts';

type ImpEnv = { Bindings: Env; Variables: RequestIdVars };
type C = Context<ImpEnv>;

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (env: Env, title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · ${platformName(env)}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** Same-origin check for this module's forms (the UI's own check lives in ui.ts). */
function sameOrigin(c: C): boolean {
  const origin = c.req.header('origin');
  return origin ? origin === new URL(c.env.ISSUER).origin : c.req.header('sec-fetch-site') === 'same-origin';
}

/** POST a JSON body to an engine endpoint with the browser's cookies; Set-Cookie is passed on. */
async function engine(c: C, path: string, body: Record<string, unknown>) {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', origin: new URL(c.env.ISSUER).origin });
  for (const name of ['cookie', 'user-agent', 'cf-connecting-ip']) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const res = await getAuth(c.env).handler(new Request(`${c.env.ISSUER}${AUTH_BASE_PATH}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  for (const cookie of res.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
  return { ok: res.ok, data: await res.json<{ message?: string } | null>().catch(() => null) };
}

/** Server-side engine endpoint call (SERVER_ONLY endpoints); Set-Cookie is passed on. */
async function serverCall(c: C, fn: 'startImpersonation' | 'stopImpersonation', body?: Record<string, unknown>) {
  const api = getAuth(c.env).api as unknown as Record<string, (o: unknown) => Promise<{ headers: Headers; response: unknown }>>;
  const { headers } = await api[fn]!({ headers: c.req.raw.headers, ...(body ? { body } : {}), returnHeaders: true });
  for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
}

const hasSessionCookie = (c: C) => /session_token=/.test(c.req.header('cookie') ?? '');

interface Pending {
  id: string;
  actor_id: string;
  target_id: string;
  reason: string;
  request_expires_at: number;
}

async function loadPending(c: C, id: string, actorId: string) {
  return c.env.DB.prepare(
    `SELECT i.id, i.actor_id, i.target_id, i.reason, i.request_expires_at, u.email, u.isAnonymous FROM impersonations i
     JOIN "user" u ON u.id = i.target_id WHERE i.id = ? AND i.actor_id = ? AND i.status = 'pending' AND i.request_expires_at > ?`,
  ).bind(id, actorId, Date.now()).first<Pending & { email: string; isAnonymous: number | null }>();
}

const confirmPage = (c: C, p: Pending & { email: string; isAnonymous: number | null }, mfa: boolean, message?: string) =>
  page(
    c.env,
    'Start a support session',
    html`${message ? html`<p role="alert">${message}</p>` : ''}
      <p>You are about to sign in as <strong>${p.isAnonymous ? `guest ${p.target_id}` : p.email}</strong> (${p.target_id}).</p>
      <p>Reason: ${p.reason}</p>
      <p>The session lasts ${IMPERSONATION_MAX_S / 60} minutes and is recorded in the audit log. Products see that the
        tokens were issued to you on behalf of this user. Account settings and the console are not available during it.</p>
      ${mfa
        ? html`<form method="post" action="/impersonation/${p.id}/start">
            <label>Code from your authenticator app <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label>
            <button>Start support session</button></form>`
        : html`<p>Support sessions require two-factor authentication. <a href="/two-factor/setup">Set it up</a> first.</p>`}`,
  );

export const impersonation = new Hono<ImpEnv>();

impersonation.get('/impersonation/:id', async (c) => {
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.redirect('/login', 302);
  const p = await loadPending(c, c.req.param('id'), session.user.id);
  if (!p) return c.html(page(c.env, 'Support session', html`<p>This request is unknown, expired or already used. Start a new one in the console.</p>`), 404);
  c.header('cache-control', 'no-store');
  return c.html(confirmPage(c, p, Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled)));
});

impersonation.post('/impersonation/:id/start', async (c) => {
  if (!sameOrigin(c)) throw new ApiError('forbidden', 'Cross-site form submission');
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.redirect('/login', 302);
  const p = await loadPending(c, c.req.param('id'), session.user.id);
  if (!p) return c.html(page(c.env, 'Support session', html`<p>This request is unknown, expired or already used.</p>`), 404);
  const mfa = Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled);
  const form = await c.req.parseBody();
  const code = typeof form.code === 'string' ? form.code.trim() : '';
  // Step-up: a current TOTP code marks this identity session as freshly verified (mfa-policy.ts).
  const verified = /^\d{6}$/.test(code) ? await engine(c, '/two-factor/verify-totp', { code }) : { ok: false, data: null };
  if (!verified.ok) return c.html(confirmPage(c, p, mfa, verified.data?.message ?? 'Invalid code'), 401);
  // The step-up may have rotated cookies; the engine reads the request's own cookie, which is unchanged.
  try {
    await serverCall(c, 'startImpersonation', { id: p.id });
  } catch (e) {
    const message = (e as { body?: { message?: string } })?.body?.message ?? (e as Error).message;
    return c.html(confirmPage(c, p, mfa, message), 403);
  }
  return c.redirect('/account', 302);
});

impersonation.post('/impersonation/stop', async (c) => {
  if (!sameOrigin(c)) throw new ApiError('forbidden', 'Cross-site form submission');
  try {
    await serverCall(c, 'stopImpersonation');
  } catch {
    return c.redirect('/account', 302);
  }
  return c.redirect('/account', 302);
});

/** Identity pages a browser may still post to during an impersonation (everything else is refused). */
const ALLOWED_POSTS: ReadonlySet<string> = new Set(['/impersonation/stop', '/consent']);

function banner(target: string, actor: string, endsAt: number): string {
  const ends = new Date(endsAt).toISOString().slice(11, 16);
  return `<div role="status" data-impersonation-banner style="background:#7c2d12;color:#fff;padding:8px 12px;font-family:system-ui,sans-serif">`
    + `Support session: signed in as <strong>${escape(target)}</strong> on behalf of ${escape(actor)}, ends at ${ends} UTC. `
    + `<form method="post" action="/impersonation/stop" style="display:inline"><button>End support session</button></form></div>`;
}

/**
 * For identity UI routes (not the engine, which guards itself): during an impersonation, refuse state
 * changes other than ending it or answering a consent prompt, refuse export downloads, and show the
 * banner on every HTML page.
 */
export function impersonationGuard(): MiddlewareHandler<ImpEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (path.startsWith(`${AUTH_BASE_PATH}/`) || path.startsWith('/setup/') || path.startsWith('/.well-known/') || !hasSessionCookie(c)) {
      return next();
    }
    const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    const actorId = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;
    if (!session || !actorId) return next();
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if ((write && !ALLOWED_POSTS.has(path)) || path.startsWith('/account/export-links/')) {
      throw new ApiError('forbidden', 'Not available during a support session (impersonation)', { reason: 'impersonation' });
    }
    await next();
    if (!(c.res.headers.get('content-type') ?? '').includes('text/html')) return;
    const actor = await c.env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(actorId).first<{ email: string }>();
    const target = (session.user as { isAnonymous?: boolean | null }).isAnonymous ? `guest ${session.user.id}` : session.user.email;
    const markup = banner(target, actor?.email ?? actorId, new Date(session.session.expiresAt).getTime());
    c.res = new HTMLRewriter().on('body', { element: (el) => void el.prepend(markup, { html: true }) }).transform(c.res);
  };
}

