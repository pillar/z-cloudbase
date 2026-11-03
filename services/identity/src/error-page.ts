// A failed browser navigation on the identity pages (a form post refused during a support session, a
// rate-limited form, an expired link) gets an HTML page in the request's language instead of the JSON
// error body, which API callers keep. The status code and the request id stay the same.
import { ApiError, newRequestId } from '@z-cloudbase/contracts';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { AUTH_BASE_PATH } from './auth.ts';
import { notice, page, tr } from './layout.ts';
import type { UiMessages } from './messages.ts';

/** Paths that are APIs (engine, operator setup, discovery): always JSON. */
const API_PREFIXES = [`${AUTH_BASE_PATH}/`, '/setup/', '/.well-known/', '/health'];

/** A top-level browser navigation (form post or link) to one of the identity pages. */
export function wantsHtmlError(c: Context): boolean {
  const path = c.req.path;
  if (API_PREFIXES.some((p) => path.startsWith(p) || path === p.replace(/\/$/, ''))) return false;
  const accept = c.req.header('accept') ?? '';
  const mode = c.req.header('sec-fetch-mode');
  return accept.includes('text/html') && (mode === undefined || mode === 'navigate');
}

function describe(t: UiMessages, e: ApiError): string {
  if (e.details?.reason === 'impersonation' || e.code === 'impersonation_restricted') return t.error_impersonation;
  switch (e.code) {
    case 'rate_limited':
      return t.error_rate_limited;
    case 'not_found':
      return t.error_not_found;
    case 'forbidden':
      return t.error_forbidden;
    case 'invalid_request':
    case 'validation_failed':
      return t.error_invalid_request;
    default:
      return t.error_generic;
  }
}

export function htmlErrorPage(err: Error, c: Context) {
  const rid: string = (c.get('requestId') as string | undefined) ?? newRequestId();
  const e = err instanceof ApiError ? err : null;
  if (!e) console.error(JSON.stringify({ request_id: rid, error: String(err), stack: err?.stack }));
  const t = tr(c);
  const apiError = e ?? new ApiError('internal', 'Internal error');
  if (apiError.code === 'rate_limited') c.header('Retry-After', '60');
  c.header('cache-control', 'no-store');
  const body = html`${notice(describe(t, apiError))}<p class="muted">${t.errorRequestId(rid)}</p><p><a href="/account">${t.backToAccount}</a></p>`;
  return c.html(page(t.errorTitle, body, { here: '/account' }), apiError.status as 400);
}
