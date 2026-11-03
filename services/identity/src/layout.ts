// Shared layout of the identity domain's server-rendered pages (ui.ts, impersonation.ts, the HTML error
// page in index.ts): language, branding and the language switch come from the request being served
// (contextStorage in index.ts). Every interpolated value is escaped by hono/html.
import type { Context } from 'hono';
import { getContext } from 'hono/context-storage';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { langOf } from './i18n.ts';
import { uiMessages, type UiMessages } from './messages.ts';
import { platformName } from './platform.ts';
import { brand } from './settings.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Messages of the request's language. */
export const tr = <E extends { Bindings: Env }>(c: Context<E>): UiMessages => uiMessages[langOf(c)];

// Light and dark (prefers-color-scheme); the brand color stays the accent of both.
const STYLE = `:root{color-scheme:light dark;--fg:#18181b;--muted:#52525b;--bg:#fff;--line:#e4e4e7;--field:#fff;--err-fg:#b91c1c;--err-bg:#fef2f2;--err-line:#fecaca}
@media (prefers-color-scheme:dark){:root{--fg:#f4f4f5;--muted:#a1a1aa;--bg:#09090b;--line:#3f3f46;--field:#18181b;--err-fg:#fca5a5;--err-bg:#450a0a;--err-line:#7f1d1d}}
body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem}header .lang{margin-left:auto}
a{color:var(--brand)}h1{font-size:1.6rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:1.75rem 0 .5rem}
button{background:var(--brand);color:#fff;border:0;border-radius:.375rem;padding:.5rem .9rem;cursor:pointer;font:inherit;font-size:.9rem}
button[disabled]{opacity:.6}button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--err-fg);border:1px solid var(--err-line)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
label{display:block;margin:.5rem 0}
input{display:block;width:100%;box-sizing:border-box;padding:.45rem .6rem;margin-top:.25rem;border:1px solid var(--line);border-radius:.375rem;background:var(--field);color:var(--fg);font:inherit}
form{margin:1rem 0}.tagline,.muted{color:var(--muted)}
[role=alert]:not([hidden]){color:var(--err-fg);background:var(--err-bg);border:1px solid var(--err-line);border-radius:.375rem;padding:.5rem .75rem}
.or{display:flex;align-items:center;gap:.75rem;color:var(--muted);font-size:.875rem;margin:1.25rem 0}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:middle}th{font-weight:600;white-space:nowrap}td:not(:first-child){white-space:nowrap}td form{margin:0}
code{overflow-wrap:anywhere}`;

/**
 * Page layout. `here` is the address the language switch reloads (default: the current GET address);
 * the tagline appears on the sign-in page only.
 */
export const page = (title: string, body: Html, o: { here?: string; tagline?: boolean } = {}) => {
  const c = getContext<{ Bindings: Env }>();
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
<link rel="icon" href="${b.logoUrl ?? 'data:,'}"><style>:root{--brand:${color}}${raw(STYLE)}</style></head>
<body><header>${b.logoUrl ? html`<img src="${b.logoUrl}" alt="${name}" height="32">` : ''}<strong>${name}</strong><a class="lang" href="${switchTo}" hreflang="${lang === 'zh' ? 'en' : 'zh'}">${t.otherLanguage}</a></header>
<main><h1>${title}</h1>${o.tagline && b.tagline ? html`<p class="tagline">${b.tagline}</p>` : ''}${body}</main></body></html>`;
};

export const notice = (message: string | undefined) => (message ? html`<p role="alert">${message}</p>` : '');
