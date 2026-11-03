// Minimal server-rendered pages of the identity domain (PRD §19.2): plain HTML forms, every
// interpolated value escaped by hono/html. A form handler forwards the submission to the
// engine's own JSON endpoint (exactly what a browser script would send) and turns the answer
// into a redirect or a re-rendered page, so all protocol and CSRF checks stay in the engine.
import { ApiError } from '@z-cloudbase/contracts';
import type { RequestIdVars } from '@z-cloudbase/security';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getContext } from 'hono/context-storage';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AUTH_BASE_PATH } from './auth.ts';
import { getAuth } from './instance.ts';
import { account, listAccountRequests } from './account.ts';
import { linkEmailPassword } from './link.ts';
import { platformName } from './platform.ts';
import {
  TURNSTILE_FIELD, clientIp, normalizeEmail, passesTurnstile, recordOutcome, resetOutcome, signInOutcome, turnstileError,
  turnstileRequired, turnstileWidget, type Attempt,
} from './turnstile.ts';

type UiEnv = { Bindings: Env; Variables: RequestIdVars };
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Pages are rendered inside a request: the deployment's name comes from its env (contextStorage in index.ts). */
const page = (title: string, body: Html) =>
  html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · ${platformName(getContext<UiEnv>().env)}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const notice = (message: string | undefined) => (message ? html`<p role="alert">${message}</p>` : '');

interface EngineAnswer {
  ok: boolean;
  status: number;
  /**
   * `url` is the next hop (client redirect, provider authorization) when the engine has one;
   * `twoFactorRedirect` means the password was right but the second factor is still due.
   */
  data: { url?: string; message?: string; twoFactorRedirect?: boolean; totpURI?: string; backupCodes?: string[] } | null;
}

/**
 * POST a JSON body to an engine endpoint on behalf of the browser: same cookies, client IP and
 * user agent; Set-Cookie (session, OAuth state) is passed back to the browser.
 */
async function engine(c: Context<UiEnv>, path: string, body: Record<string, unknown>): Promise<EngineAnswer> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', origin: new URL(c.env.ISSUER).origin });
  for (const name of ['cookie', 'user-agent', 'cf-connecting-ip']) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const res = await getAuth(c.env).handler(
    new Request(`${c.env.ISSUER}${AUTH_BASE_PATH}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
  for (const cookie of res.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
  return { ok: res.ok, status: res.status, data: await res.json<EngineAnswer['data']>().catch(() => null) };
}

/**
 * State-changing requests must come from the identity domain itself (login CSRF; cookies are
 * SameSite=Lax). Safe methods pass; every other method needs a same-origin Origin header.
 */
const sameOrigin: MiddlewareHandler<UiEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const origin = c.req.header('origin');
  const ok = origin ? origin === new URL(c.env.ISSUER).origin : c.req.header('sec-fetch-site') === 'same-origin';
  if (!ok) throw new ApiError('forbidden', 'Cross-site form submission');
  await next();
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

// --- Turnstile on the credential forms (src/turnstile.ts; same rules as the JSON endpoints) ---

type Widget = Html | '';
const TURNSTILE_MESSAGE = 'Please complete the challenge below to continue';

/** The Turnstile widget when this IP (or, given an email, this account) must pass a challenge. */
async function challenge(c: Context<UiEnv>, email: string | null = null): Promise<Widget> {
  return (await turnstileRequired(c.env, { ip: clientIp(c), email })) ? turnstileWidget(c.env.TURNSTILE_SITE_KEY) : '';
}

const formAttempt = (c: Context<UiEnv>, form: Record<string, unknown>): Attempt => ({
  ip: clientIp(c),
  email: normalizeEmail(form.email),
  token: str(form[TURNSTILE_FIELD]) || null,
});

export const ui = new Hono<UiEnv>();
ui.use(sameOrigin);

// --- sign in / register / password reset -------------------------------------------------

/** `oauth_query` is the engine-signed authorization request; it must be posted back unchanged. */
const loginForm = (oauthQuery: string, message?: string, widget: Widget = '') =>
  page(
    'Sign in',
    html`${notice(message)}<form method="post" action="/login">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}">
      ${widget}<button>Sign in</button></form>
      <form method="post" action="/login/social"><input type="hidden" name="oauth_query" value="${oauthQuery}">
      <button name="provider" value="google">Continue with Google</button>
      <button name="provider" value="apple">Continue with Apple</button></form>
      <p><a href="${withQuery('/register', oauthQuery)}">Create an account</a> · <a href="/forgot-password">Forgot password?</a></p>`,
  );

ui.get('/login', async (c) => c.html(loginForm(new URL(c.req.url).search.slice(1), undefined, await challenge(c))));

ui.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  const attempt = formAttempt(c, form);
  if (!(await passesTurnstile(c.env, attempt))) {
    return c.html(loginForm(oauthQuery, TURNSTILE_MESSAGE, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  const r = await engine(c, '/sign-in/email', {
    email: str(form.email),
    password: str(form.password),
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  });
  await recordOutcome(c.env, attempt, signInOutcome(r.status));
  if (!r.ok) return c.html(loginForm(oauthQuery, r.data?.message ?? 'Sign-in failed', await challenge(c, attempt.email)), 401);
  // TOTP is enabled: the engine set a short-lived two_factor cookie instead of a session.
  if (r.data?.twoFactorRedirect) return c.redirect(`/two-factor?${new URLSearchParams({ oauth_query: oauthQuery })}`, 302);
  // Inside an authorization request the engine answers with the client redirect.
  return c.redirect(r.data?.url || '/account', 302);
});

/** The continuation of `/guest`: only this issuer's authorization endpoint (no open redirect). */
export function guestContinuation(issuer: string, authorize: string | undefined): string | null {
  if (!authorize) return null;
  let url: URL;
  try {
    url = new URL(authorize);
  } catch {
    return null;
  }
  return url.origin === new URL(issuer).origin && url.pathname === `${AUTH_BASE_PATH}/oauth2/authorize` ? `${url.pathname}${url.search}` : null;
}

/**
 * Guest entry for products that start anonymously, e.g. Web games (PRD §4.2 item 4): the Web SDK's
 * `signInWithRedirect({ guest: true })` navigates to `GET /guest?authorize=<authorization URL>`. Without a
 * session this signs in anonymously (a first-party cookie on the identity domain) and then continues the
 * authorization request, which returns a code to the product; an existing session (guest or not) is kept,
 * so a signed-in user is never turned into a guest. Rate limited per IP (index.ts).
 */
ui.get('/guest', async (c) => {
  const target = guestContinuation(c.env.ISSUER, c.req.query('authorize'));
  if (!target) throw new ApiError('invalid_request', "authorize must be this issuer's authorization endpoint");
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    const r = await engine(c, '/sign-in/anonymous', {});
    if (!r.ok) throw new ApiError('unavailable', 'Guest sign-in is not available, try again later');
  }
  return c.redirect(target, 302);
});

ui.post('/login/social', async (c) => {
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  const r = await engine(c, '/sign-in/social', {
    provider: str(form.provider),
    callbackURL: '/account',
    errorCallbackURL: '/login',
    disableRedirect: true,
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  });
  if (!r.ok || !r.data?.url) return c.html(loginForm(oauthQuery, r.data?.message ?? 'This sign-in method is not available'), 400);
  return c.redirect(r.data.url, 302);
});

const registerForm = (oauthQuery: string, message?: string, widget: Widget = '') =>
  page(
    'Create an account',
    html`${notice(message)}<form method="post" action="/register">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}">
      ${widget}<button>Create account</button></form>`,
  );

ui.get('/register', async (c) => c.html(registerForm(new URL(c.req.url).search.slice(1), undefined, await challenge(c))));

ui.post('/register', async (c) => {
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    return c.html(registerForm(oauthQuery, TURNSTILE_MESSAGE, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  // The engine answers the same whether or not the email is already registered (anti-enumeration).
  const r = await engine(c, '/sign-up/email', { email: str(form.email), password: str(form.password), name: '' });
  if (!r.ok) return c.html(registerForm(oauthQuery, r.data?.message ?? 'Registration failed'), 400);
  return c.html(
    page(
      'Check your inbox',
      html`<p>If this address can be registered, we sent a verification link to it. You can sign in now.</p>
        <p><a href="${withQuery('/login', oauthQuery)}">Sign in</a></p>`,
    ),
  );
});

const forgotForm = (message?: string, widget: Widget = '') =>
  page(
    'Reset your password',
    html`${notice(message)}<form method="post" action="/forgot-password"><label>Email <input name="email" type="email" required></label>${widget}<button>Send reset link</button></form>`,
  );

ui.get('/forgot-password', async (c) => c.html(forgotForm(undefined, await challenge(c))));

ui.post('/forgot-password', async (c) => {
  const form = await c.req.parseBody();
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    return c.html(forgotForm(TURNSTILE_MESSAGE, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  // Whatever the engine answers (known, unknown or malformed address), the page is the same.
  await engine(c, '/request-password-reset', { email: str(form.email), redirectTo: '/reset-password' });
  return c.html(page('Check your inbox', html`<p>If an account exists for this address, we sent a reset link.</p>`));
});

const resetForm = (token: string, message?: string, widget: Widget = '') =>
  page(
    'Choose a new password',
    html`${notice(message)}<form method="post" action="/reset-password"><input type="hidden" name="token" value="${token}">
      <label>New password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      ${widget}<button>Set password</button></form>`,
  );

// The engine's /api/auth/reset-password/:token link redirects here with `?token=` (or `?error=`).
ui.get('/reset-password', async (c) =>
  c.html(resetForm(c.req.query('token') ?? '', c.req.query('error') ? 'This link is invalid or expired' : undefined, await challenge(c))),
);

ui.post('/reset-password', async (c) => {
  const form = await c.req.parseBody();
  const attempt = formAttempt(c, form);
  if (!(await passesTurnstile(c.env, attempt))) {
    return c.html(resetForm(str(form.token), TURNSTILE_MESSAGE, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  const r = await engine(c, '/reset-password', { token: str(form.token), newPassword: str(form.password) });
  await recordOutcome(c.env, attempt, resetOutcome(r.status));
  if (!r.ok) return c.html(resetForm(str(form.token), r.data?.message ?? 'This link is invalid or expired', await challenge(c)), 400);
  return c.html(page('Password changed', html`<p>All sessions were signed out. <a href="/login">Sign in</a></p>`));
});

// --- second factor (PRD §19.9, §19.11): sign-in challenge, step-up and TOTP enrollment ----------

/** Only an authorization request of this issuer may be resumed after the MFA pages (no open redirect). */
function resumeTarget(c: Context<UiEnv>, value: string): string | null {
  if (!value || !URL.canParse(value, c.env.ISSUER)) return null;
  const u = new URL(value, c.env.ISSUER);
  if (u.origin !== new URL(c.env.ISSUER).origin || u.pathname !== `${AUTH_BASE_PATH}/oauth2/authorize`) return null;
  return `${u.pathname}${u.search}`;
}

/** `oauth_query`: the signed authorization request of a sign-in challenge; `return`: a step-up's authorization. */
const codeForm = (oauthQuery: string, ret: string, message?: string) =>
  page(
    'Two-factor authentication',
    html`${notice(message)}<form method="post" action="/two-factor">
      <label>Code from your authenticator app, or a backup code <input name="code" autocomplete="one-time-code" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}"><input type="hidden" name="return" value="${ret}">
      <button>Verify</button></form>`,
  );

ui.get('/two-factor', (c) => c.html(codeForm(c.req.query('oauth_query') ?? '', c.req.query('return') ?? '')));

// The engine verifies against the signed-in session (step-up) or the two_factor cookie of a
// password sign-in (challenge); a challenge inside an authorization request resumes it.
ui.post('/two-factor', async (c) => {
  const form = await c.req.parseBody();
  const code = str(form.code).trim();
  const oauthQuery = str(form.oauth_query);
  const ret = str(form.return);
  // Six digits come from the authenticator app; anything else is a one-time backup code.
  const path = /^\d{6}$/.test(code) ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code';
  const r = await engine(c, path, { code, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
  if (!r.ok) return c.html(codeForm(oauthQuery, ret, r.data?.message ?? 'Invalid code'), 401);
  return c.redirect(r.data?.url || resumeTarget(c, ret) || '/account', 302);
});

const setupStart = (ret: string, message?: string) =>
  page(
    'Set up two-factor authentication',
    html`${notice(message)}<p>The console requires an authenticator app (TOTP). Confirm your password to start.</p>
      <form method="post" action="/two-factor/setup"><label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <input type="hidden" name="return" value="${ret}"><button>Continue</button></form>`,
  );

const setupConfirmForm = (ret: string) =>
  html`<form method="post" action="/two-factor/setup/confirm">
    <label>6-digit code from the app <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
    <input type="hidden" name="return" value="${ret}"><button>Turn on two-factor authentication</button></form>`;

ui.get('/two-factor/setup', async (c) => {
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const ret = c.req.query('return') ?? '';
  if (session.user.twoFactorEnabled) return c.redirect(resumeTarget(c, ret) ?? '/account', 302);
  return c.html(setupStart(ret));
});

// Starts (or restarts) enrollment: a new secret and backup codes, shown on this response only.
ui.post('/two-factor/setup', async (c) => {
  const form = await c.req.parseBody();
  const ret = str(form.return);
  const password = str(form.password);
  const r = await engine(c, '/two-factor/enable', password ? { password } : {});
  const uri = r.data?.totpURI;
  if (!r.ok || !uri) return c.html(setupStart(ret, r.data?.message ?? 'Two-factor setup could not be started'), r.ok ? 500 : 400);
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  c.header('cache-control', 'no-store');
  return c.html(
    page(
      'Set up two-factor authentication',
      html`<p>Add this key to your authenticator app, then enter the code it shows.</p>
        <p>Key: <code data-totp-secret>${secret}</code></p>
        <p>Or open: <a href="${uri}">${uri}</a></p>
        <h2>Backup codes</h2>
        <p>Each code signs you in once if you lose the app. Store them now: they are not shown again.</p>
        <ul>${(r.data?.backupCodes ?? []).map((code) => html`<li><code data-backup-code>${code}</code></li>`)}</ul>
        ${setupConfirmForm(ret)}`,
    ),
  );
});

// The first valid code turns TOTP on; the engine replaces the session with one that passed it.
ui.post('/two-factor/setup/confirm', async (c) => {
  const form = await c.req.parseBody();
  const ret = str(form.return);
  const r = await engine(c, '/two-factor/verify-totp', { code: str(form.code).trim() });
  if (!r.ok) {
    return c.html(page('Set up two-factor authentication', html`${notice(r.data?.message ?? 'Invalid code')}${setupConfirmForm(ret)}`), 400);
  }
  return c.redirect(resumeTarget(c, ret) ?? '/account', 302);
});

// --- consent (third-party clients only; first-party product clients skip it) ---------------

ui.get('/consent', (c) => {
  const q = new URL(c.req.url).searchParams;
  return c.html(
    page(
      'Allow access?',
      html`<p><strong>${q.get('client_id') ?? ''}</strong> asks for: ${q.get('scope') ?? ''}</p>
        <form method="post" action="/consent"><input type="hidden" name="oauth_query" value="${q.toString()}">
        <button name="accept" value="true">Allow</button> <button name="accept" value="false">Deny</button></form>`,
    ),
  );
});

ui.post('/consent', async (c) => {
  const form = await c.req.parseBody();
  const r = await engine(c, '/oauth2/consent', { accept: form.accept === 'true', oauth_query: str(form.oauth_query) });
  if (!r.ok || !r.data?.url) throw new ApiError('invalid_request', r.data?.message ?? 'Consent request is invalid or expired');
  return c.redirect(r.data.url, 302);
});

// --- user center: own memberships and linked sign-in methods ------------------------------

async function currentSession(c: Context<UiEnv>) {
  return getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

// The cross-product membership list exists only here, on the identity domain, for the user
// themself; product APIs never expose memberships of other products (PRD §6.1).
ui.get('/account', async (c) => {
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const { results } = await c.env.DB.prepare(
    `SELECT m.product_id, p.name, m.status, m.joined_at, m.last_seen_at FROM product_memberships m
     JOIN products p ON p.id = m.product_id WHERE m.user_id = ? ORDER BY m.joined_at`,
  )
    .bind(session.user.id)
    .all<{ product_id: string; name: string; status: string; joined_at: number; last_seen_at: number | null }>();
  const who = session.user.isAnonymous ? 'Guest (anonymous)' : session.user.email;
  const requests = await listAccountRequests(c.env.DB, session.user.id);
  const pendingDeletion = requests.find((r) => r.kind === 'delete' && r.status === 'pending');
  return c.html(
    page(
      'Your account',
      html`<p>Signed in as ${who}</p>
        <h2>Products</h2>
        ${results.length
          ? html`<table><thead><tr><th>Product</th><th>Status</th><th>Joined</th><th>Last seen</th></tr></thead><tbody>
              ${results.map((m) => html`<tr><td>${m.name}</td><td>${m.status}</td><td>${fmt(m.joined_at)}</td><td>${fmt(m.last_seen_at)}</td></tr>`)}
              </tbody></table>`
          : html`<p>You have not used any product yet.</p>`}
        <p><a href="/link">Sign-in methods</a> · ${session.user.twoFactorEnabled
          ? 'Two-factor authentication is on'
          : html`<a href="/two-factor/setup">Set up two-factor authentication</a>`}</p>
        <h2>Your data</h2>
        <p>Exporting your data and deleting your account need a sign-in within the last few minutes.
          A download link works once and expires after 15 minutes.</p>
        <form method="post" action="/account/export"><button>Request a data export</button></form>
        ${pendingDeletion
          ? html`<p>Your account is scheduled for deletion on ${pendingDeletion.due_at.slice(0, 10)}.</p>
              <form method="post" action="/account/deletion/cancel"><button>Cancel account deletion</button></form>`
          : html`<form method="post" action="/account/deletion"><button>Delete my account</button></form>`}
        ${requests.length
          ? html`<table><thead><tr><th>Request</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>
              ${requests.map((r) => html`<tr><td>${r.kind === 'export' ? 'Data export' : 'Account deletion'}</td><td>${r.status}</td><td>${r.requested_at.slice(0, 10)}</td>
                <td>${r.kind === 'export' && r.status === 'completed'
                  ? html`<form method="post" action="/account/exports/${r.id}/link"><button>Download</button></form>`
                  : ''}</td></tr>`)}
              </tbody></table>`
          : ''}`,
    ),
  );
});

// Deletion / export requests and one-time export links (PRD §19.8), behind the same-origin check above.
ui.route('/', account);

const linkPage = async (c: Context<UiEnv>, message?: string, status: 200 | 400 | 403 | 409 = 200, widget?: Widget) => {
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const accounts = await getAuth(c.env).api.listUserAccounts({ headers: c.req.raw.headers });
  const providers = new Set(accounts.map((a) => a.providerId));
  return c.html(
    page(
      'Sign-in methods',
      html`${notice(message)}<ul>${[...providers].map((p) => html`<li>${p === 'credential' ? 'Email and password' : p}</li>`)}</ul>
        ${session.user.isAnonymous && !providers.has('credential')
          ? html`<form method="post" action="/link/email"><label>Email <input name="email" type="email" required></label>
              <label>Password <input name="password" type="password" minlength="8" required></label>
              ${widget ?? (await challenge(c))}<button>Add email and password</button></form>`
          : ''}
        <form method="post" action="/link/social">
          ${providers.has('google') ? '' : html`<button name="provider" value="google">Link Google</button>`}
          ${providers.has('apple') ? '' : html`<button name="provider" value="apple">Link Apple</button>`}
        </form>
        <p><a href="/account">Back</a></p>`,
    ),
    status,
  );
};

ui.get('/link', (c) => linkPage(c, c.req.query('error') ? 'Linking failed' : undefined));

// JSON for API callers (anonymous upgrade from a client), redirect for the form above. Both pass
// the Turnstile check first (PRD §19.11): header for JSON, the widget's form field otherwise.
ui.post('/link/email', async (c) => {
  const isForm = (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded');
  if (!isForm) {
    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    const attempt: Attempt = { ip: clientIp(c), email: normalizeEmail(body?.email), token: c.req.header(TURNSTILE_FIELD) ?? null };
    if (!(await passesTurnstile(c.env, attempt))) throw turnstileError(c.env);
    return c.json(await linkEmailPassword(getAuth(c.env), c.req.raw.headers, body));
  }
  const form = await c.req.parseBody();
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    return linkPage(c, TURNSTILE_MESSAGE, 403, turnstileWidget(c.env.TURNSTILE_SITE_KEY));
  }
  try {
    await linkEmailPassword(getAuth(c.env), c.req.raw.headers, { email: form.email, password: form.password });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return linkPage(c, e.message, e.status === 409 ? 409 : 400);
  }
  return c.redirect('/account', 302);
});

// Engine-side checks apply: the 5-minute re-authentication window and conflict handling.
ui.post('/link/social', async (c) => {
  const form = await c.req.parseBody();
  const r = await engine(c, '/link-social', {
    provider: str(form.provider),
    callbackURL: '/account',
    errorCallbackURL: '/link',
    disableRedirect: true,
  });
  if (!r.ok || !r.data?.url) return linkPage(c, r.data?.message ?? 'Linking failed', 403);
  return c.redirect(r.data.url, 302);
});
