// Typed fetch wrapper for /v1/admin. The access token is injected per request; errors use the unified body (PRD §19.5).

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** `error.details` of the unified body (e.g. `{ reason: 'mfa_required' }`). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiClientOptions {
  origin: string;
  getToken: () => Promise<string>;
  /** Called on a 401 (expired or invalid session) before the error is thrown. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

/** Query parameters; an array value repeats the key (`filter=a&filter=b`). Empty values are dropped. */
export type Query = Record<string, string | number | readonly string[] | undefined>;

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T = void>(path: string): Promise<T>;
  /** GET a file (e.g. an export); errors are the unified JSON body, as with `get`. */
  download(path: string, query?: Query): Promise<Blob>;
  /** GET a non-JSON body (e.g. CSV export) together with the response headers. */
  getText(path: string, query?: Query): Promise<{ text: string; headers: Headers }>;
}

export function buildUrl(origin: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item !== undefined && item !== '') params.append(k, String(item));
    }
  }
  const qs = params.toString();
  return `${origin}/v1/admin${path}${qs ? `?${qs}` : ''}`;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetch ?? fetch;

  type ErrorBody = { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } } | null;

  async function send(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
    return doFetch(buildUrl(opts.origin, path, query), {
      method,
      headers: {
        authorization: `Bearer ${await opts.getToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function fail(res: Response, payload: ErrorBody): never {
    if (res.status === 401) opts.onUnauthorized?.();
    const e = payload?.error;
    throw new ApiRequestError(res.status, e?.code ?? 'internal', e?.message ?? `Request failed (${res.status})`, e?.request_id, e?.details);
  }

  async function request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const res = await send(method, path, query, body);
    if (res.status === 204) return undefined as T;
    const payload = (await res.json().catch(() => null)) as ErrorBody | T;
    if (!res.ok) fail(res, payload as ErrorBody);
    return payload as T;
  }

  return {
    get: (path, query) => request('GET', path, query),
    post: (path, body) => request('POST', path, undefined, body),
    patch: (path, body) => request('PATCH', path, undefined, body),
    put: (path, body) => request('PUT', path, undefined, body),
    delete: (path) => request('DELETE', path),
    download: async (path, query) => {
      const res = await send('GET', path, query);
      if (!res.ok) fail(res, (await res.json().catch(() => null)) as ErrorBody);
      return res.blob();
    },
    getText: async (path, query) => {
      const res = await send('GET', path, query);
      if (!res.ok) fail(res, (await res.json().catch(() => null)) as ErrorBody);
      return { text: await res.text(), headers: res.headers };
    },
  };
}
