// Language of the identity pages and mail (PRD §21.4): `?lang=` (stored in a cookie, then redirected
// away so signed authorization parameters stay intact) → cookie → Accept-Language → DEFAULT_LANG.
import type { Context, MiddlewareHandler } from 'hono';
import { getContext } from 'hono/context-storage';
import { getCookie, setCookie } from 'hono/cookie';
import { defaultLang, isLang, type Lang } from './settings.ts';

export const LANG_COOKIE = 'zcb_lang';
const YEAR_S = 365 * 24 * 3600;

type Message = string | ((...args: never[]) => string);
/** `en` must provide every key of `zh` with the same shape (checked by the compiler), as in the console. */
export function defineMessages<T extends Record<string, Message>>(m: { zh: T; en: { [K in keyof T]: T[K] } }): { zh: T; en: T } {
  return m;
}

/** The first `zh*` / `en*` language range of an Accept-Language header, by q-value (ties keep header order). */
export function fromAcceptLanguage(header: string | undefined | null): Lang | null {
  if (!header) return null;
  const ranges = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { primary: (tag ?? '').trim().toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q), i };
    })
    .filter((r) => r.q > 0 && (r.primary === 'zh' || r.primary === 'en'))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return (ranges[0]?.primary as Lang | undefined) ?? null;
}

/** The language of a request (without `?lang=`, which the middleware below turns into the cookie). */
export function langOf<E extends { Bindings: Env }>(c: Context<E>): Lang {
  const cookie = getCookie(c, LANG_COOKIE);
  if (isLang(cookie)) return cookie;
  return fromAcceptLanguage(c.req.header('accept-language')) ?? defaultLang(c.env);
}

/**
 * The language of the request being served, for code without the Hono context at hand (mail sent from
 * engine callbacks). Outside a request (identity RPC) it is `fallback`, else the deployment default.
 */
export function requestLang(env: Env, fallback?: Lang): Lang {
  if (fallback) return fallback;
  try {
    return langOf(getContext<{ Bindings: Env }>());
  } catch {
    return defaultLang(env);
  }
}

/** `GET ...?lang=zh|en`: remember the choice and reload the same address without the parameter. */
export const langSwitch: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const wanted = c.req.query('lang');
  if (c.req.method !== 'GET' || wanted === undefined) return next();
  const url = new URL(c.req.url);
  url.searchParams.delete('lang');
  if (isLang(wanted)) {
    setCookie(c, LANG_COOKIE, wanted, { path: '/', maxAge: YEAR_S, sameSite: 'Lax', secure: true, httpOnly: true });
  }
  return c.redirect(`${url.pathname}${url.search}`, 302);
};
