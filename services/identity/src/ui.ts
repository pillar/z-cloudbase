// Minimal server-rendered pages of the identity domain (PRD §19.2): plain HTML forms, every
// interpolated value escaped by hono/html. A form handler forwards the submission to the
// engine's own JSON endpoint (exactly what a browser script would send) and turns the answer
// into a redirect or a re-rendered page, so all protocol and CSRF checks stay in the engine.
// v3.1: bilingual (zh / en, src/i18n.ts, src/messages.ts), deployment branding (src/settings.ts),
// passkeys and magic links (PRD §21.3), registration modes and invitations (PRD §21.2).
import { ApiError } from '@z-cloudbase/contracts';
import type { RequestIdVars } from '@z-cloudbase/security';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getContext } from 'hono/context-storage';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AUTH_BASE_PATH } from './auth.ts';
import { magicLinkAvailable, mailAvailable } from './email.ts';
import { langOf, langSwitch } from './i18n.ts';
import { emailSignupAvailable, getAuth } from './instance.ts';
import { account, listAccountRequests } from './account.ts';
import { claimInvitation, completeInvitation, findPendingInvitation, redemption, releaseInvitation } from './invitations.ts';
import { linkEmailPassword } from './link.ts';
import { uiMessages, type UiMessages } from './messages.ts';
import { PASSKEY_SCRIPT } from './passkey.ts';
import { platformName } from './platform.ts';
import { brand, passkeysEnabled, requireEmailVerification, signupMode } from './settings.ts';
import {
  TURNSTILE_FIELD, clientIp, normalizeEmail, passesTurnstile, recordOutcome, resetOutcome, signInOutcome, turnstileError,
  turnstileRequired, turnstileWidget, type Attempt,
} from './turnstile.ts';

type UiEnv = { Bindings: Env; Variables: RequestIdVars };
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
type C = Context<UiEnv>;

/** Messages of the request's language. */
const tr = (c: C): UiMessages => uiMessages[langOf(c)];

/**
 * Page layout. Pages are rendered inside a request: name, branding and language come from its env and
 * headers (contextStorage in index.ts). `here` is the address the language switch reloads (default:
 * the current GET address); the tagline appears on the sign-in page only.
 */
const page = (title: string, body: Html, o: { here?: string; tagline?: boolean } = {}) => {
  const c = getContext<UiEnv>();
  const lang = langOf(c);
  const t = uiMessages[lang];
  const b = brand(c.env);
  const name = platformName(c.env);
  const url = new URL(c.req.url);
  const here = o.here ?? (c.req.method === 'GET' ? `${url.pathname}${url.search}` : url.pathname);
  const switchTo = `${here}${here.includes('?') ? '&' : '?'}lang=${lang === 'zh' ? 'en' : 'zh'}`;
  // The color passed the strict hex check in settings.ts; hono/html escapes it as well.
  const color = b.primaryColor ?? '#4f46e5';
  return html`<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · ${name}</title>
<style>:root{--brand:${color}}body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}header{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem}header .lang{margin-left:auto}a{color:var(--brand)}button{background:var(--brand);color:#fff;border:0;border-radius:.375rem;padding:.5rem .9rem;cursor:pointer}button[disabled]{opacity:.6}label{display:block;margin:.5rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.4rem}form{margin:1rem 0}.tagline{color:#555}</style></head>
<body><header>${b.logoUrl ? html`<img src="${b.logoUrl}" alt="${name}" height="32">` : ''}<strong>${name}</strong><a class="lang" href="${switchTo}" hreflang="${lang === 'zh' ? 'en' : 'zh'}">${t.otherLanguage}</a></header>
<main><h1>${title}</h1>${o.tagline && b.tagline ? html`<p class="tagline">${b.tagline}</p>` : ''}${body}</main></body></html>`;
};

const notice = (message: string | undefined) => (message ? html`<p role="alert">${message}</p>` : '');
/** The passkey script and the element its errors go to. */
const passkeyAssets = () => html`<p id="passkey-error" role="alert" hidden></p><script src="/assets/passkey.js" defer></script>`;

interface EngineAnswer {
  ok: boolean;
  status: number;
  /**
   * `url` is the next hop (client redirect, provider authorization) when the engine has one;
   * `twoFactorRedirect` means the password was right but the second factor is still due.
   */
  data: { url?: string; message?: string; code?: string; twoFactorRedirect?: boolean; totpURI?: string; backupCodes?: string[] } | null;
}

/**
 * POST a JSON body to an engine endpoint on behalf of the browser: same cookies, client IP, user agent
 * and language; Set-Cookie (session, OAuth state) is passed back to the browser.
 */
async function engine(c: C, path: string, body: Record<string, unknown>): Promise<EngineAnswer> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', origin: new URL(c.env.ISSUER).origin });
  for (const name of ['cookie', 'user-agent', 'cf-connecting-ip', 'accept-language']) {
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

/** The Turnstile widget when this IP (or, given an email, this account) must pass a challenge. */
async function challenge(c: C, email: string | null = null): Promise<Widget> {
  return (await turnstileRequired(c.env, { ip: clientIp(c), email })) ? turnstileWidget(c.env.TURNSTILE_SITE_KEY) : '';
}

const formAttempt = (c: C, form: Record<string, unknown>): Attempt => ({
  ip: clientIp(c),
  email: normalizeEmail(form.email),
  token: str(form[TURNSTILE_FIELD]) || null,
});

/** Social providers this deployment has credentials for. */
const socialConfigured = (env: Env) => ({
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  apple: Boolean(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET),
});

/** Anyone may register with Email / Password right now (open mode and a working verification path). */
const openRegistration = (env: Env) => signupMode(env) === 'open' && emailSignupAvailable(env);

export const ui = new Hono<UiEnv>();
ui.use(sameOrigin);
// `?lang=` on any page: stored in a cookie, then the same address without it (PRD §21.4).
ui.use(langSwitch);

ui.get('/assets/passkey.js', (c) => {
  c.header('content-type', 'text/javascript; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  c.header('x-content-type-options', 'nosniff');
  return c.body(PASSKEY_SCRIPT);
});

// The engine's default landing page (e.g. a verification link mailed on a sign-in attempt).
ui.get('/', (c) => c.redirect('/account', 302));

// --- sign in / register / password reset -------------------------------------------------

/** `oauth_query` is the engine-signed authorization request; it must be posted back unchanged. */
const loginForm = (c: C, oauthQuery: string, message?: string, widget: Widget = '') => {
  const t = tr(c);
  const social = socialConfigured(c.env);
  return page(
    t.signIn,
    html`${notice(message)}<form method="post" action="/login">
      <label>${t.email} <input name="email" type="email" autocomplete="username webauthn" required></label>
      <label>${t.password} <input name="password" type="password" autocomplete="current-password" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}">
      ${widget}<button>${t.signInButton}</button></form>
      ${passkeysEnabled(c.env)
        ? html`<p><button type="button" hidden data-passkey-signin data-oauth-query="${oauthQuery}" data-failed="${t.passkeyFailed}">${t.passkeySignIn}</button></p>${passkeyAssets()}`
        : ''}
      ${magicLinkAvailable(c.env)
        ? html`<form method="post" action="/login/magic-link"><label>${t.email} <input name="email" type="email" autocomplete="email" required></label>
            <input type="hidden" name="oauth_query" value="${oauthQuery}"><button>${t.magicLinkButton}</button></form>`
        : ''}
      ${social.google || social.apple
        ? html`<form method="post" action="/login/social"><input type="hidden" name="oauth_query" value="${oauthQuery}">
            ${social.google ? html`<button name="provider" value="google">${t.continueWithGoogle}</button> ` : ''}
            ${social.apple ? html`<button name="provider" value="apple">${t.continueWithApple}</button>` : ''}</form>`
        : ''}
      <p>${openRegistration(c.env) ? html`<a href="${withQuery('/register', oauthQuery)}">${t.createAccount}</a> · ` : ''}<a href="/forgot-password">${t.forgotPassword}</a></p>`,
    { here: withQuery('/login', oauthQuery), tagline: true },
  );
};

/** The sign-in page's query is the signed authorization request (`lang` was removed by the switch). */
ui.get('/login', async (c) => {
  const t = tr(c);
  const error = c.req.query('error');
  const verified = c.req.query('verified');
  let query = new URL(c.req.url).search.slice(1);
  if (error !== undefined || verified !== undefined) {
    // Landing from a magic link / verification link: those are not part of an authorization request.
    const q = new URLSearchParams(query);
    for (const k of ['error', 'verified', 'magic']) q.delete(k);
    query = q.toString();
  }
  // The magic-link error target is `/login?magic=1`; the engine adds its own `error` code to it.
  const magic = c.req.query('magic') !== undefined;
  const message = error !== undefined ? (magic ? t.magicLinkInvalid : t.signInFailed) : verified !== undefined ? t.emailVerified : undefined;
  return c.html(loginForm(c, query, message, await challenge(c)));
});

ui.post('/login', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  const attempt = formAttempt(c, form);
  if (!(await passesTurnstile(c.env, attempt))) {
    return c.html(loginForm(c, oauthQuery, t.turnstilePrompt, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  const r = await engine(c, '/sign-in/email', {
    email: str(form.email),
    password: str(form.password),
    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
  });
  await recordOutcome(c.env, attempt, signInOutcome(r.status));
  if (!r.ok) return c.html(loginForm(c, oauthQuery, r.data?.message ?? t.signInFailed, await challenge(c, attempt.email)), r.status === 403 ? 403 : 401);
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
 * so a signed-in user is never turned into a guest. Rate limited per IP (index.ts). New guests only in the
 * `open` registration mode (PRD §21.2).
 */
ui.get('/guest', async (c) => {
  const target = guestContinuation(c.env.ISSUER, c.req.query('authorize'));
  if (!target) throw new ApiError('invalid_request', "authorize must be this issuer's authorization endpoint");
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    if (signupMode(c.env) !== 'open') throw new ApiError('forbidden', 'Guest access is not available on this platform', { reason: 'signup_closed' });
    const r = await engine(c, '/sign-in/anonymous', {});
    if (!r.ok) throw new ApiError('unavailable', tr(c).guestUnavailable);
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
  if (!r.ok || !r.data?.url) return c.html(loginForm(c, oauthQuery, r.data?.message ?? tr(c).methodUnavailable), 400);
  return c.redirect(r.data.url, 302);
});

/**
 * Where a magic link continues: the authorization request it was asked for (from the signed query,
 * without the signature parameters and `prompt=login`), or the account page. The engine only follows
 * same-origin targets, and src/magic-link.ts restricts them to this issuer's own pages.
 */
export function magicLinkContinuation(oauthQuery: string): string {
  if (!oauthQuery) return '/account';
  const q = new URLSearchParams(oauthQuery);
  for (const k of [...q.keys()]) if (k === 'sig' || k === 'exp' || k.startsWith('ba_')) q.delete(k);
  if (q.get('prompt') === 'login') q.delete('prompt');
  if (!q.get('client_id')) return '/account';
  return `${AUTH_BASE_PATH}/oauth2/authorize?${q}`;
}

// Magic link (PRD §21.3): the same answer whatever the engine did (anti-enumeration).
ui.post('/login/magic-link', async (c) => {
  const t = tr(c);
  if (!magicLinkAvailable(c.env)) throw new ApiError('not_found', 'Not found');
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  const target = magicLinkContinuation(oauthQuery);
  const r = await engine(c, '/sign-in/magic-link', {
    email: str(form.email).trim(),
    callbackURL: target,
    newUserCallbackURL: target,
    errorCallbackURL: '/login?magic=1',
  });
  if (!r.ok && r.data?.code === 'INVALID_CALLBACK') throw new ApiError('invalid_request', 'Invalid continuation');
  if (r.status === 400 && r.data?.code === 'VALIDATION_ERROR') return c.html(loginForm(c, oauthQuery, r.data?.message ?? t.signInFailed), 400);
  return c.html(page(t.checkInbox, html`<p>${t.magicLinkSent}</p><p><a href="${withQuery('/login', oauthQuery)}">${t.signIn}</a></p>`));
});

const registerForm = (c: C, oauthQuery: string, o: { message?: string; widget?: Widget; invite?: { token: string; email: string } } = {}) => {
  const t = tr(c);
  return page(
    t.registerTitle,
    html`${notice(o.message)}${o.invite ? html`<p>${t.invitedAs(o.invite.email)}</p>` : ''}<form method="post" action="/register">
      ${o.invite
        ? html`<input type="hidden" name="invite" value="${o.invite.token}">`
        : html`<label>${t.email} <input name="email" type="email" autocomplete="username" required></label>`}
      <label>${t.password} <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}">
      ${o.widget ?? ''}<button>${t.registerButton}</button></form>`,
    { here: o.invite ? `/register?${new URLSearchParams({ invite: o.invite.token })}` : withQuery('/register', oauthQuery) },
  );
};

const closedPage = (c: C, message: string, status: 403 | 404 = 403) => c.html(page(tr(c).registerTitle, html`<p role="alert">${message}</p>`), status);

ui.get('/register', async (c) => {
  const t = tr(c);
  const token = c.req.query('invite');
  if (token !== undefined) {
    // Invitations (PRD §21.2): every unusable link looks the same.
    const inv = signupMode(c.env) === 'closed' || !emailSignupAvailable(c.env) ? null : await findPendingInvitation(c.env.DB, token);
    if (!inv) return closedPage(c, t.inviteInvalid, 404);
    return c.html(registerForm(c, '', { invite: { token, email: inv.email }, widget: await challenge(c) }));
  }
  if (!openRegistration(c.env)) return closedPage(c, t.registerClosed);
  return c.html(registerForm(c, new URL(c.req.url).search.slice(1), { widget: await challenge(c) }));
});

ui.post('/register', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  const oauthQuery = str(form.oauth_query);
  const token = str(form.invite);
  if (!token && !openRegistration(c.env)) return closedPage(c, t.registerClosed);
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    const inv = token ? await findPendingInvitation(c.env.DB, token) : null;
    return c.html(
      registerForm(c, oauthQuery, { message: t.turnstilePrompt, widget: turnstileWidget(c.env.TURNSTILE_SITE_KEY), ...(inv ? { invite: { token, email: inv.email } } : {}) }),
      403,
    );
  }
  const verifyAfter = requireEmailVerification(c.env);
  if (token) {
    if (signupMode(c.env) === 'closed' || !emailSignupAvailable(c.env)) return closedPage(c, t.inviteInvalid, 404);
    const claimed = await claimInvitation(c.env.DB, token);
    if (!claimed) return closedPage(c, t.inviteInvalid, 404);
    const ctx = await getAuth(c.env).$context;
    // Someone registered this address since the invitation was made: nothing left to redeem.
    if (await ctx.internalAdapter.findUserByEmail(claimed.email)) {
      await releaseInvitation(c.env.DB, claimed.id);
      return closedPage(c, t.inviteInvalid, 404);
    }
    const r = await redemption.run(claimed, () =>
      engine(c, '/sign-up/email', { email: claimed.email, password: str(form.password), name: '', callbackURL: '/login?verified=1' }),
    );
    const user = r.ok ? await ctx.internalAdapter.findUserByEmail(claimed.email) : null;
    if (!user) {
      await releaseInvitation(c.env.DB, claimed.id);
      return c.html(registerForm(c, '', { message: r.data?.message ?? t.registerFailed, invite: { token, email: claimed.email } }), 400);
    }
    await completeInvitation(c.env.DB, claimed.id, user.user.id, c.get('requestId'));
    const done = claimed.verified || !verifyAfter ? t.registerDone : t.registerSent;
    return c.html(page(t.checkInbox, html`<p>${done}</p><p><a href="/login">${t.signIn}</a></p>`));
  }
  // The engine answers the same whether or not the email is already registered (anti-enumeration).
  const r = await engine(c, '/sign-up/email', { email: str(form.email), password: str(form.password), name: '', callbackURL: '/login?verified=1' });
  if (!r.ok) return c.html(registerForm(c, oauthQuery, { message: r.data?.message ?? t.registerFailed }), r.status === 403 ? 403 : 400);
  return c.html(
    page(t.checkInbox, html`<p>${verifyAfter ? t.registerSent : t.registerSentNoVerify}</p><p><a href="${withQuery('/login', oauthQuery)}">${t.signIn}</a></p>`),
  );
});

const forgotForm = (c: C, message?: string, widget: Widget = '') => {
  const t = tr(c);
  if (!mailAvailable(c.env)) return page(t.resetTitle, html`<p role="alert">${t.resetUnavailable}</p>`);
  return page(
    t.resetTitle,
    html`${notice(message)}<form method="post" action="/forgot-password"><label>${t.email} <input name="email" type="email" required></label>${widget}<button>${t.resetButton}</button></form>`,
  );
};

ui.get('/forgot-password', async (c) => c.html(forgotForm(c, undefined, await challenge(c))));

ui.post('/forgot-password', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  if (!mailAvailable(c.env)) return c.html(forgotForm(c));
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    return c.html(forgotForm(c, t.turnstilePrompt, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  // Whatever the engine answers (known, unknown or malformed address), the page is the same.
  await engine(c, '/request-password-reset', { email: str(form.email), redirectTo: '/reset-password' });
  return c.html(page(t.checkInbox, html`<p>${t.resetSent}</p>`));
});

const resetForm = (c: C, token: string, message?: string, widget: Widget = '') => {
  const t = tr(c);
  return page(
    t.newPasswordTitle,
    html`${notice(message)}<form method="post" action="/reset-password"><input type="hidden" name="token" value="${token}">
      <label>${t.newPassword} <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      ${widget}<button>${t.setPassword}</button></form>`,
  );
};

// The engine's /api/auth/reset-password/:token link redirects here with `?token=` (or `?error=`).
ui.get('/reset-password', async (c) =>
  c.html(resetForm(c, c.req.query('token') ?? '', c.req.query('error') ? tr(c).linkInvalid : undefined, await challenge(c))),
);

ui.post('/reset-password', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  const attempt = formAttempt(c, form);
  if (!(await passesTurnstile(c.env, attempt))) {
    return c.html(resetForm(c, str(form.token), t.turnstilePrompt, turnstileWidget(c.env.TURNSTILE_SITE_KEY)), 403);
  }
  const r = await engine(c, '/reset-password', { token: str(form.token), newPassword: str(form.password) });
  await recordOutcome(c.env, attempt, resetOutcome(r.status));
  if (!r.ok) return c.html(resetForm(c, str(form.token), r.data?.message ?? t.linkInvalid, await challenge(c)), 400);
  return c.html(page(t.passwordChanged, html`<p>${t.passwordChangedBody} <a href="/login">${t.signIn}</a></p>`));
});

// --- second factor (PRD §19.9, §19.11, §21.3): sign-in challenge, step-up and enrollment ----------

/** Only an authorization request of this issuer may be resumed after the MFA pages (no open redirect). */
function resumeTarget(c: C, value: string): string | null {
  if (!value || !URL.canParse(value, c.env.ISSUER)) return null;
  const u = new URL(value, c.env.ISSUER);
  if (u.origin !== new URL(c.env.ISSUER).origin || u.pathname !== `${AUTH_BASE_PATH}/oauth2/authorize`) return null;
  return `${u.pathname}${u.search}`;
}

/** `oauth_query`: the signed authorization request of a sign-in challenge; `return`: a step-up's authorization. */
const codeForm = (c: C, oauthQuery: string, ret: string, message?: string) => {
  const t = tr(c);
  return page(
    t.twoFactorTitle,
    html`${notice(message)}<form method="post" action="/two-factor">
      <label>${t.twoFactorCode} <input name="code" autocomplete="one-time-code" required></label>
      <input type="hidden" name="oauth_query" value="${oauthQuery}"><input type="hidden" name="return" value="${ret}">
      <button>${t.verify}</button></form>
      ${passkeysEnabled(c.env)
        ? html`<p>${t.orUsePasskey}</p><p><button type="button" hidden data-passkey-signin data-oauth-query="${oauthQuery}" data-return="${ret}" data-failed="${t.passkeyFailed}">${t.passkeySignIn}</button></p>${passkeyAssets()}`
        : ''}`,
    { here: `/two-factor?${new URLSearchParams({ oauth_query: oauthQuery, return: ret })}` },
  );
};

ui.get('/two-factor', (c) => c.html(codeForm(c, c.req.query('oauth_query') ?? '', c.req.query('return') ?? '')));

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
  if (!r.ok) return c.html(codeForm(c, oauthQuery, ret, r.data?.message ?? tr(c).invalidCode), 401);
  return c.redirect(r.data?.url || resumeTarget(c, ret) || '/account', 302);
});

/** After a passkey sign-in without a signed authorization request: resume `return` if it is ours. */
ui.get('/passkey/continue', (c) => c.redirect(resumeTarget(c, c.req.query('return') ?? '') ?? '/account', 302));

const setupStart = (c: C, ret: string, message?: string) => {
  const t = tr(c);
  const next = `/two-factor?${new URLSearchParams({ return: ret })}`;
  return page(
    t.setupTitle,
    html`${notice(message)}<p>${t.setupIntro}</p>
      <form method="post" action="/two-factor/setup"><label>${t.password} <input name="password" type="password" autocomplete="current-password"></label>
      <input type="hidden" name="return" value="${ret}"><button>${t.continue}</button></form>
      ${passkeysEnabled(c.env)
        ? html`<p>${t.setupPasskeyInstead}</p><p><button type="button" hidden data-passkey-register data-next="${next}" data-failed="${t.passkeyFailed}">${t.addPasskey}</button></p>${passkeyAssets()}`
        : ''}`,
    { here: `/two-factor/setup?${new URLSearchParams({ return: ret })}` },
  );
};

const setupConfirmForm = (t: UiMessages, ret: string) =>
  html`<form method="post" action="/two-factor/setup/confirm">
    <label>${t.sixDigitCode} <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
    <input type="hidden" name="return" value="${ret}"><button>${t.enable2fa}</button></form>`;

ui.get('/two-factor/setup', async (c) => {
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const ret = c.req.query('return') ?? '';
  if (session.user.twoFactorEnabled) return c.redirect(resumeTarget(c, ret) ?? '/account', 302);
  return c.html(setupStart(c, ret));
});

// Starts (or restarts) enrollment: a new secret and backup codes, shown on this response only.
ui.post('/two-factor/setup', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  const ret = str(form.return);
  const password = str(form.password);
  const r = await engine(c, '/two-factor/enable', password ? { password } : {});
  const uri = r.data?.totpURI;
  if (!r.ok || !uri) return c.html(setupStart(c, ret, r.data?.message ?? t.setupFailed), r.ok ? 500 : 400);
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  c.header('cache-control', 'no-store');
  return c.html(
    page(
      t.setupTitle,
      html`<p>${t.setupKey}</p>
        <p>${t.key}: <code data-totp-secret>${secret}</code></p>
        <p>${t.orOpen} <a href="${uri}">${uri}</a></p>
        <h2>${t.backupCodes}</h2>
        <p>${t.backupCodesIntro}</p>
        <ul>${(r.data?.backupCodes ?? []).map((code) => html`<li><code data-backup-code>${code}</code></li>`)}</ul>
        ${setupConfirmForm(t, ret)}`,
      { here: `/two-factor/setup?${new URLSearchParams({ return: ret })}` },
    ),
  );
});

// The first valid code turns TOTP on; the engine replaces the session with one that passed it.
ui.post('/two-factor/setup/confirm', async (c) => {
  const t = tr(c);
  const form = await c.req.parseBody();
  const ret = str(form.return);
  const r = await engine(c, '/two-factor/verify-totp', { code: str(form.code).trim() });
  if (!r.ok) {
    return c.html(page(t.setupTitle, html`${notice(r.data?.message ?? t.invalidCode)}${setupConfirmForm(t, ret)}`), 400);
  }
  return c.redirect(resumeTarget(c, ret) ?? '/account', 302);
});

// --- consent (third-party clients only; first-party product clients skip it) ---------------

ui.get('/consent', (c) => {
  const t = tr(c);
  const q = new URL(c.req.url).searchParams;
  return c.html(
    page(
      t.consentTitle,
      html`<p><strong>${q.get('client_id') ?? ''}</strong> ${t.consentAsks} ${q.get('scope') ?? ''}</p>
        <form method="post" action="/consent"><input type="hidden" name="oauth_query" value="${q.toString()}">
        <button name="accept" value="true">${t.allow}</button> <button name="accept" value="false">${t.deny}</button></form>`,
    ),
  );
});

ui.post('/consent', async (c) => {
  const form = await c.req.parseBody();
  const r = await engine(c, '/oauth2/consent', { accept: form.accept === 'true', oauth_query: str(form.oauth_query) });
  if (!r.ok || !r.data?.url) throw new ApiError('invalid_request', r.data?.message ?? tr(c).consentInvalid);
  return c.redirect(r.data.url, 302);
});

// --- user center: own memberships, sign-in methods, passkeys, data ----------------------------

async function currentSession(c: C) {
  return getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
}

const fmt = (ms: number | Date | string | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | number | null;
}

// The cross-product membership list exists only here, on the identity domain, for the user
// themself; product APIs never expose memberships of other products (PRD §6.1).
ui.get('/account', async (c) => {
  const t = tr(c);
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const { results } = await c.env.DB.prepare(
    `SELECT m.product_id, p.name, m.status, m.joined_at, m.last_seen_at FROM product_memberships m
     JOIN products p ON p.id = m.product_id WHERE m.user_id = ? ORDER BY m.joined_at`,
  )
    .bind(session.user.id)
    .all<{ product_id: string; name: string; status: string; joined_at: number; last_seen_at: number | null }>();
  const anonymous = Boolean(session.user.isAnonymous);
  const who = anonymous ? t.guest : session.user.email;
  const requests = await listAccountRequests(c.env.DB, session.user.id);
  const pendingDeletion = requests.find((r) => r.kind === 'delete' && r.status === 'pending');
  const passkeys = passkeysEnabled(c.env) && !anonymous
    ? (await c.env.DB.prepare('SELECT id, name, createdAt FROM passkey WHERE userId = ? ORDER BY createdAt').bind(session.user.id).all<PasskeyRow>()).results
    : null;
  return c.html(
    page(
      t.accountTitle,
      html`<p>${t.signedInAs(who)}</p>
        <h2>${t.products}</h2>
        ${results.length
          ? html`<table><thead><tr><th>${t.product}</th><th>${t.status}</th><th>${t.joined}</th><th>${t.lastSeen}</th></tr></thead><tbody>
              ${results.map((m) => html`<tr><td>${m.name}</td><td>${m.status}</td><td>${fmt(m.joined_at)}</td><td>${fmt(m.last_seen_at)}</td></tr>`)}
              </tbody></table>`
          : html`<p>${t.noProducts}</p>`}
        <p><a href="/link">${t.signInMethods}</a> · ${session.user.twoFactorEnabled ? t.twoFactorOn : html`<a href="/two-factor/setup">${t.setup2fa}</a>`}</p>
        ${passkeys
          ? html`<h2>${t.passkeys}</h2>
              ${passkeys.length
                ? html`<table><thead><tr><th>${t.passkeyName}</th><th>${t.created}</th><th></th></tr></thead><tbody>
                    ${passkeys.map((p) => html`<tr><td>${p.name || t.passkeys}</td><td>${fmt(p.createdAt)}</td>
                      <td><form method="post" action="/account/passkeys/delete"><input type="hidden" name="id" value="${p.id}"><button>${t.remove}</button></form></td></tr>`)}
                    </tbody></table>`
                : html`<p>${t.noPasskeys}</p>`}
              <p><button type="button" hidden data-passkey-register data-next="/account" data-failed="${t.passkeyFailed}">${t.addPasskey}</button></p>
              <p>${t.passkeyHint}</p>${passkeyAssets()}`
          : ''}
        <h2>${t.yourData}</h2>
        <p>${t.dataIntro}</p>
        <form method="post" action="/account/export"><button>${t.requestExport}</button></form>
        ${pendingDeletion
          ? html`<p>${t.deletionScheduled(pendingDeletion.due_at.slice(0, 10))}</p>
              <form method="post" action="/account/deletion/cancel"><button>${t.cancelDeletion}</button></form>`
          : html`<form method="post" action="/account/deletion"><button>${t.deleteAccount}</button></form>`}
        ${requests.length
          ? html`<table><thead><tr><th>${t.request}</th><th>${t.status}</th><th>${t.requested}</th><th></th></tr></thead><tbody>
              ${requests.map((r) => html`<tr><td>${r.kind === 'export' ? t.dataExport : t.accountDeletion}</td><td>${r.status}</td><td>${r.requested_at.slice(0, 10)}</td>
                <td>${r.kind === 'export' && r.status === 'completed'
                  ? html`<form method="post" action="/account/exports/${r.id}/link"><button>${t.download}</button></form>`
                  : ''}</td></tr>`)}
              </tbody></table>`
          : ''}`,
    ),
  );
});

// Removing a passkey goes through the engine (ownership check, PRD §19.4 re-authentication window).
ui.post('/account/passkeys/delete', async (c) => {
  if (!(await currentSession(c))) return c.redirect('/login', 303);
  const form = await c.req.parseBody();
  const r = await engine(c, '/passkey/delete-passkey', { id: str(form.id) });
  if (r.status === 403 && r.data?.code === 'SESSION_NOT_FRESH') return c.redirect('/login', 303);
  // The engine answers 401 for another user's passkey: indistinguishable from an unknown one here.
  if (!r.ok) throw new ApiError(r.status === 401 || r.status === 404 ? 'not_found' : 'invalid_request', 'Passkey not found');
  return c.redirect('/account', 303);
});

// Deletion / export requests and one-time export links (PRD §19.8), behind the same-origin check above.
ui.route('/', account);

const linkPage = async (c: C, message?: string, status: 200 | 400 | 403 | 409 = 200, widget?: Widget) => {
  const t = tr(c);
  const session = await currentSession(c);
  if (!session) return c.redirect('/login', 302);
  const accounts = await getAuth(c.env).api.listUserAccounts({ headers: c.req.raw.headers });
  const providers = new Set(accounts.map((a) => a.providerId));
  const social = socialConfigured(c.env);
  return c.html(
    page(
      t.signInMethods,
      html`${notice(message)}<ul>${[...providers].map((p) => html`<li>${p === 'credential' ? t.emailAndPassword : p}</li>`)}</ul>
        ${session.user.isAnonymous && !providers.has('credential') && emailSignupAvailable(c.env)
          ? html`<form method="post" action="/link/email"><label>${t.email} <input name="email" type="email" required></label>
              <label>${t.password} <input name="password" type="password" minlength="8" required></label>
              ${widget ?? (await challenge(c))}<button>${t.addEmailPassword}</button></form>`
          : ''}
        <form method="post" action="/link/social">
          ${providers.has('google') || !social.google ? '' : html`<button name="provider" value="google">${t.linkGoogle}</button>`}
          ${providers.has('apple') || !social.apple ? '' : html`<button name="provider" value="apple">${t.linkApple}</button>`}
        </form>
        <p><a href="/account">${t.back}</a></p>`,
    ),
    status,
  );
};

ui.get('/link', (c) => linkPage(c, c.req.query('error') ? tr(c).linkingFailed : undefined));

// JSON for API callers (anonymous upgrade from a client), redirect for the form above. Both pass
// the Turnstile check first (PRD §19.11): header for JSON, the widget's form field otherwise.
// Without a way to verify the address (PRD §21.2) the upgrade to Email / Password is unavailable.
ui.post('/link/email', async (c) => {
  if (!emailSignupAvailable(c.env)) {
    throw new ApiError('forbidden', 'Email sign-in is not available on this platform', { reason: 'email_unavailable' });
  }
  const isForm = (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded');
  if (!isForm) {
    const body = await c.req.json<{ email?: unknown }>().catch(() => null);
    const attempt: Attempt = { ip: clientIp(c), email: normalizeEmail(body?.email), token: c.req.header(TURNSTILE_FIELD) ?? null };
    if (!(await passesTurnstile(c.env, attempt))) throw turnstileError(c.env);
    return c.json(await linkEmailPassword(getAuth(c.env), c.req.raw.headers, body));
  }
  const form = await c.req.parseBody();
  if (!(await passesTurnstile(c.env, formAttempt(c, form)))) {
    return linkPage(c, tr(c).turnstilePrompt, 403, turnstileWidget(c.env.TURNSTILE_SITE_KEY));
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
  if (!r.ok || !r.data?.url) return linkPage(c, r.data?.message ?? tr(c).linkingFailed, 403);
  return c.redirect(r.data.url, 302);
});
