import { SERVICE_KEY_RE } from '@z-cloudbase/contracts';
import { PlatformError, errorFromResponse } from './errors.ts';

export interface ServerClientConfig {
  /** API origin; calls go to `{endpoint}/v1/...`. */
  endpoint: string;
  /** Identity (OIDC issuer) origin. */
  issuer: string;
  /** `sk_...` key. Keep it server-side; it must never reach a browser. */
  serviceKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout, default 15s. */
  timeoutMs?: number;
  /** First retry delay for retryable failures (doubles each attempt), default 500ms. */
  retryBaseMs?: number;
  /**
   * Log / event buffers flush on their own at this interval. Off by default: Workers must not
   * run timers outside a request, so call `flush()` (e.g. inside `ctx.waitUntil`) instead.
   */
  flushIntervalMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_BASE_MS = 500;

export function validateConfig(c: ServerClientConfig): void {
  if (!SERVICE_KEY_RE.test(c.serviceKey)) throw new PlatformError('sdk_error', 'serviceKey must be an sk_ key');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Forward an end user's access token. */
  token?: string;
  /** Retries after the first attempt; only retryable failures are retried. Default 0. */
  retries?: number;
}

export type Http = <T>(path: string, opts?: RequestOptions) => Promise<T>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `op`, retrying retryable PlatformErrors with exponential backoff + jitter. */
export async function withRetry<T>(op: () => Promise<T>, retries: number, baseMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (attempt >= retries || !(e instanceof PlatformError) || !e.retryable) throw e;
      await sleep(baseMs * 2 ** attempt * (0.5 + Math.random() / 2));
    }
  }
}

/** One fetch with a timeout; network failures and timeouts become retryable PlatformErrors. */
export async function fetchWithTimeout(
  f: typeof fetch, url: string, init: RequestInit, timeoutMs: number,
): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new PlatformError(timedOut ? 'timeout' : 'network_error', timedOut ? 'Request timed out' : 'Network error', {
      retryable: true,
    });
  }
}

export const resolveFetch = (c: { fetch?: typeof fetch }): typeof fetch =>
  c.fetch ?? ((input, init) => globalThis.fetch(input, init));

export function createHttp(c: ServerClientConfig): Http {
  const f = resolveFetch(c);
  const base = c.endpoint.replace(/\/+$/, '');
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryBaseMs = c.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  return async <T>(path: string, o: RequestOptions = {}) => {
    const url = new URL(`${base}/v1${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { 'X-Platform-Key': c.serviceKey, ...o.headers };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';

    return withRetry(async () => {
      const res = await fetchWithTimeout(f, url.toString(), {
        method: o.method ?? 'GET',
        headers,
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      }, timeoutMs);
      const text = await res.text().catch(() => '');
      if (!res.ok) throw errorFromResponse(res, text);
      return (text ? JSON.parse(text) : undefined) as T;
    }, o.retries ?? 0, retryBaseMs);
  };
}
