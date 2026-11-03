import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, buildUrl, createApiClient } from '../src/api.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(respond: () => Response, onUnauthorized = vi.fn()) {
  const fetchFn = vi.fn(async (_url: unknown, _init?: RequestInit) => respond());
  const api = createApiClient({ origin: 'https://api.example', getToken: async () => 'TOKEN', onUnauthorized, fetch: fetchFn as typeof fetch });
  return { api, fetchFn, onUnauthorized };
}

describe('buildUrl', () => {
  it('prefixes /v1/admin and drops empty query values', () => {
    expect(buildUrl('https://api.example', '/products/p1/logs', { env: 'prod', level: '', request_id: undefined, limit: 50 })).toBe(
      'https://api.example/v1/admin/products/p1/logs?env=prod&limit=50',
    );
    expect(buildUrl('https://api.example', '/products')).toBe('https://api.example/v1/admin/products');
  });
});

describe('api client', () => {
  it('sends the bearer token and a JSON body, and returns parsed JSON', async () => {
    const { api, fetchFn } = client(() => json({ id: 'x' }, 201));
    expect(await api.post('/products', { product_id: 'abc' })).toEqual({ id: 'x' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/admin/products');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer TOKEN', 'content-type': 'application/json' });
    expect(init!.body).toBe('{"product_id":"abc"}');
  });

  it('sends no body or content-type on GET and handles 204', async () => {
    const { api, fetchFn } = client(() => new Response(null, { status: 204 }));
    expect(await api.delete('/team/tm_1')).toBeUndefined();
    expect(fetchFn.mock.calls[0]![1]!.body).toBeUndefined();
    expect(fetchFn.mock.calls[0]![1]!.headers).not.toHaveProperty('content-type');
  });

  it('turns the unified error body into ApiRequestError', async () => {
    const { api } = client(() => json({ error: { code: 'forbidden', message: 'Not allowed: keys:manage', request_id: 'req_1', retryable: false } }, 403));
    const err = await api.get('/products/p/service-keys').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'Not allowed: keys:manage', requestId: 'req_1' });
  });

  it('notifies on 401 and still throws; non-JSON failures get a generic error', async () => {
    const unauth = client(() => json({ error: { code: 'token_expired', message: 'expired' } }, 401));
    await expect(unauth.api.get('/me')).rejects.toMatchObject({ status: 401, code: 'token_expired' });
    expect(unauth.onUnauthorized).toHaveBeenCalledTimes(1);

    const bad = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(bad.api.get('/me')).rejects.toMatchObject({ status: 502, code: 'internal' });
    expect(bad.onUnauthorized).not.toHaveBeenCalled();
  });
});
