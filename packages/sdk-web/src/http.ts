import { PlatformError, errorFromResponse } from './errors.ts';
import { DEFAULT_RETRY_BASE_MS, DEFAULT_TIMEOUT_MS, type ClientConfig } from './config.ts';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Attach the signed-in user's bearer token; `required` fails with `unauthenticated` if there is none. */
  auth?: 'required' | 'optional';
  /** Explicit bearer token (wins over `auth`). */
  token?: string;
  /** Retries after the first attempt; only retryable failures are retried. Default 0. */
  retries?: number;
  keepalive?: boolean;
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

export function createHttp(c: ClientConfig, getAccessToken?: () => Promise<string | null>): Http {
  const f: typeof fetch = c.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = c.endpoint.replace(/\/+$/, '');
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryBaseMs = c.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  return async <T>(path: string, o: RequestOptions = {}) => {
    const url = new URL(`${base}/v1${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const attempt = async (): Promise<T> => {
      const headers: Record<string, string> = { 'X-Platform-Key': c.publishableKey, ...o.headers };
      let token = o.token;
      if (!token && o.auth && getAccessToken) {
        try {
          token = (await getAccessToken()) ?? undefined;
        } catch (e) {
          if (o.auth === 'required') throw e;
        }
      }
      if (!token && o.auth === 'required') throw new PlatformError('unauthenticated', 'Not signed in');
      if (token) headers.Authorization = `Bearer ${token}`;
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await fetchWithTimeout(f, url.toString(), {
        method: o.method ?? 'GET',
        headers,
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        ...(o.keepalive ? { keepalive: true } : {}),
      }, timeoutMs);
      const text = await res.text().catch(() => '');
      if (!res.ok) throw errorFromResponse(res, text);
      return (text ? JSON.parse(text) : undefined) as T;
    };
    return withRetry(attempt, o.retries ?? 0, retryBaseMs);
  };
}
