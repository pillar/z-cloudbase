// A minimal browser for e2e tests: per-host cookie jar, manual redirects, HTML form posts with the
// page's Origin, CORS enforcement for cross-origin fetches, and window shims for the Web SDK.
// Each Browser has its own client IP (cf-connecting-ip) so per-IP auth limits apply per "device".
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
// Imported by path: dependency-free RFC 6238 helper shared with the identity worker tests.
import { totp } from '../../../packages/testing/src/totp.ts';

/** Response token of Cloudflare's Turnstile testing site keys; the local identity worker accepts only this. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** Credentials a simulated user types; `totp` is their authenticator app (filled on enrollment). */
export interface Login {
  email: string;
  password: string;
  totp?: { secret?: string; backupCodes?: string[] };
}

/**
 * HTTP/1.1 request without fetch semantics. Node's fetch (undici) always sends
 * `Sec-Fetch-Mode: cors`, which makes the identity engine answer navigations with JSON instead of
 * redirects; a browser navigation sends `navigate`. Redirects are never followed.
 */
function rawHttp(url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: Object.fromEntries(headers) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, value);
        }
        const status = res.statusCode ?? 0;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    // A hung request (seen on staging under bursts) fails fast and names itself instead of hitting the hook timeout.
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${url.origin}${url.pathname} timed out after 30s`)));
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Name=value cookies per host (ports share cookies, as in browsers). */
export class CookieJar {
  private readonly hosts = new Map<string, Map<string, string>>();
  header(url: URL): string | null {
    const jar = this.hosts.get(url.hostname);
    return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
  }
  store(url: URL, res: Response) {
    let jar = this.hosts.get(url.hostname);
    if (!jar) this.hosts.set(url.hostname, (jar = new Map()));
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }
  clear(host: string) {
    this.hosts.delete(host);
  }
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Value of `<input name="…" value="…">` in a page (hono/html escapes attribute values). */
export function inputValue(html: string, name: string): string | null {
  const m = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html);
  return m ? unescapeHtml(m[1]!) : null;
}

/** Thrown where a real browser would block a cross-origin response (missing / wrong CORS headers). */
export class CorsError extends TypeError {}

export class Browser {
  readonly jar = new CookieJar();
  readonly ip = `10.${[...randomBytes(3)].join('.')}`;
  /** Every login page the identity domain showed (to prove SSO needs no second password prompt). */
  readonly loginPrompts: string[] = [];
  /** x-request-id of every API response seen, by path. */
  readonly requestIds: Array<{ path: string; requestId: string | null; status: number }> = [];

  constructor(readonly issuer: string) {}

  /** A same-site navigation or form post on any origin, carrying cookies. Redirects are NOT followed. */
  async request(url: string, init: RequestInit & { form?: Record<string, string>; json?: unknown } = {}): Promise<Response> {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    // Only the local stack trusts a client-sent IP; Cloudflare's edge rejects it (error 1000).
    if (u.protocol === 'http:') headers.set('cf-connecting-ip', this.ip);
    const cookie = this.jar.header(u);
    if (cookie) headers.set('cookie', cookie);
    let body = init.body;
    if (init.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    // Same-origin form / fetch from a page on this origin. Navigations and form posts look like a
    // browser's (Node's fetch would otherwise announce itself as a CORS fetch).
    const method = init.method ?? (body !== undefined ? 'POST' : 'GET');
    if (init.json === undefined && !headers.has('sec-fetch-mode')) {
      headers.set('sec-fetch-mode', 'navigate');
      if (!headers.has('accept')) headers.set('accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    }
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin')) headers.set('origin', u.origin);
    if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('Browser.request bodies must be strings');
    const res = await rawHttp(u, method, headers, (body as string | undefined) ?? null);
    this.jar.store(u, res);
    return res;
  }

  /**
   * Open an authorization URL and follow identity-domain redirects. A login page is answered with
   * `login` (or fails when none is given); a Turnstile widget on it is "solved" with the testing
   * keys' dummy token. The admin MFA pages (PRD §19.11) are answered with `login.totp`: enrollment
   * stores the secret and backup codes there, the code prompt uses the stored secret.
   * Resolves with the client callback URL.
   */
  async authorize(url: string, login?: Login): Promise<URL> {
    let next = new URL(url);
    for (let hop = 0; hop < 12; hop++) {
      if (next.origin !== new URL(this.issuer).origin) return next;
      const res = await this.request(next.toString());
      if (res.status >= 300 && res.status < 400) {
        next = new URL(res.headers.get('location')!, next);
        continue;
      }
      const html = await res.text();
      let post: Response | null = null;
      if (res.status === 200 && next.pathname === '/login') {
        this.loginPrompts.push(next.toString());
        if (!login) throw new Error('identity domain asked for a password');
        post = await this.request(`${this.issuer}/login`, {
          form: {
            email: login.email, password: login.password, oauth_query: inputValue(html, 'oauth_query') ?? '',
            ...(html.includes('class="cf-turnstile"') ? { 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN } : {}),
          },
        });
      } else if (res.status === 200 && next.pathname === '/two-factor/setup') {
        if (!login?.totp) throw new Error('identity domain asked to enroll TOTP');
        const page = await this.request(`${this.issuer}/two-factor/setup`, { form: { password: login.password, return: inputValue(html, 'return') ?? '' } });
        const text = await page.text();
        const secret = /data-totp-secret>([A-Z2-7]+)</.exec(text)?.[1];
        if (page.status !== 200 || !secret) throw new Error(`TOTP setup failed (${page.status}): ${text.slice(0, 300)}`);
        login.totp.secret = secret;
        login.totp.backupCodes = [...text.matchAll(/data-backup-code>([^<]+)</g)].map((m) => m[1]!);
        post = await this.request(`${this.issuer}/two-factor/setup/confirm`, { form: { code: await totp(secret), return: inputValue(text, 'return') ?? '' } });
      } else if (res.status === 200 && next.pathname === '/two-factor') {
        if (!login?.totp?.secret) throw new Error('identity domain asked for a TOTP code');
        post = await this.request(`${this.issuer}/two-factor`, {
          form: { code: await totp(login.totp.secret), oauth_query: inputValue(html, 'oauth_query') ?? '', return: inputValue(html, 'return') ?? '' },
        });
      }
      if (!post) throw new Error(`unexpected ${res.status} at ${next.pathname}: ${html.slice(0, 300)}`);
      if (post.status !== 302) throw new Error(`${next.pathname} failed (${post.status}): ${(await post.text()).slice(0, 300)}`);
      next = new URL(post.headers.get('location')!, this.issuer);
    }
    throw new Error('too many redirects');
  }

  /**
   * `fetch` as a script on `pageOrigin` would do it: cross-origin requests carry Origin, get a CORS
   * preflight when they are not "simple", and fail like in a browser when the response does not
   * allow the page origin. No cookies are sent cross-origin (credentials: 'same-origin').
   */
  pageFetch(pageOrigin: string): typeof fetch {
    return async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const local = url.protocol === 'http:';
      if (local) headers.set('cf-connecting-ip', this.ip);
      const crossOrigin = url.origin !== pageOrigin;
      if (crossOrigin) {
        headers.set('origin', pageOrigin);
        const safelisted = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'cf-connecting-ip', 'origin']);
        const ct = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const simpleType = !headers.has('content-type') || ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(ct);
        const custom = [...headers.keys()].filter((h) => !safelisted.has(h));
        if (!['GET', 'HEAD', 'POST'].includes(method) || !simpleType || custom.length > 0) {
          const pre = await fetch(url, {
            method: 'OPTIONS',
            headers: {
              origin: pageOrigin, ...(local ? { 'cf-connecting-ip': this.ip } : {}), 'access-control-request-method': method,
              ...(custom.length || !simpleType ? { 'access-control-request-headers': [...custom, ...(simpleType ? [] : ['content-type'])].join(',') } : {}),
            },
          });
          const allowOrigin = pre.headers.get('access-control-allow-origin');
          const allowHeaders = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
          const allowMethods = (pre.headers.get('access-control-allow-methods') ?? '').toUpperCase();
          const needed = [...custom, ...(simpleType ? [] : ['content-type'])];
          if (!pre.ok || (allowOrigin !== pageOrigin && allowOrigin !== '*') || needed.some((h) => !allowHeaders.includes(h))
            || (!['GET', 'HEAD', 'POST'].includes(method) && !allowMethods.includes(method))) {
            throw new CorsError(`CORS preflight to ${url.origin}${url.pathname} rejected for ${pageOrigin}`);
          }
        }
      }
      const res = await fetch(url, { ...init, method, headers, redirect: 'manual' });
      if (url.pathname.startsWith('/v1/')) this.requestIds.push({ path: url.pathname, requestId: res.headers.get('x-request-id'), status: res.status });
      if (crossOrigin) {
        const allow = res.headers.get('access-control-allow-origin');
        if (allow !== pageOrigin && allow !== '*') throw new CorsError(`CORS: ${url.origin}${url.pathname} does not allow ${pageOrigin}`);
      }
      return res;
    };
  }
}

/** In-memory Web Storage. */
export class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  get length() {
    return this.m.size;
  }
}

/**
 * A browser tab on an app origin: the window globals the Web SDK reads (`location`, `sessionStorage`,
 * `localStorage`) are swapped in while the tab is active. Navigations requested by the SDK
 * (`location.assign`) are recorded instead of performed.
 */
export class Tab {
  readonly sessionStorage = new MemoryStorage();
  readonly localStorage = new MemoryStorage();
  href: string;
  assigned: string | null = null;

  constructor(readonly browser: Browser, readonly origin: string, path = '/') {
    this.href = `${origin}${path}`;
  }

  activate(): void {
    const tab = this;
    const location = {
      get href() {
        return tab.href;
      },
      get origin() {
        return new URL(tab.href).origin;
      },
      get pathname() {
        return new URL(tab.href).pathname;
      },
      assign(url: string) {
        tab.assigned = url;
      },
    };
    for (const [name, value] of [['location', location], ['sessionStorage', this.sessionStorage], ['localStorage', this.localStorage]] as const) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
  }

  get fetch(): typeof fetch {
    return this.browser.pageFetch(this.origin);
  }
}
