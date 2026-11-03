import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../src/storage.ts';
import { apiError, baseConfig, fakeFetch, json, type Recorded } from './helpers.ts';

const PRESIGNED = 'https://r2.test/bucket/obj_1?X-Amz-Signature=abc';
const signedIn = { getAccessToken: async () => 'user-token' as string | null };

const create = () => json({
  object_id: 'obj_1', method: 'PUT', url: PRESIGNED, headers: { 'Content-Type': 'image/png', 'x-amz-meta-a': 'b' },
  expires_at: '2026-10-08T00:10:00Z',
});
const object = { id: 'obj_1', bucket: 'avatars', filename: 'a.png', content_type: 'image/png', size: 3, status: 'available', created_at: 'x' };

function setup(handler?: (r: Recorded) => Response | Promise<Response>, auth = signedIn) {
  const api = fakeFetch(handler ?? ((r) => {
    if (r.url === PRESIGNED) return new Response(null, { status: 200 });
    if (r.url.endsWith('/complete')) return json(object);
    return create();
  }));
  return { api, storage: createStorage(baseConfig({ fetch: api.fetch }), auth) };
}

afterEach(() => vi.unstubAllGlobals());

describe('createUpload', () => {
  it('creates, PUTs the bytes with the presigned headers only, then completes', async () => {
    const { api, storage } = setup();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    const result = await storage.createUpload({ bucket: 'avatars', file: blob, filename: 'a.png' });

    expect(result).toEqual(object);
    expect(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/storage/uploads', 'PUT /bucket/obj_1', 'POST /v1/storage/uploads/obj_1/complete',
    ]);
    const [create, put, complete] = api.calls as [Recorded, Recorded, Recorded];
    expect(create.json()).toEqual({ bucket: 'avatars', filename: 'a.png', content_type: 'image/png', size: 3 });
    expect(create.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.headers.get('authorization')).toBe('Bearer user-token');
    expect(create.headers.get('x-platform-key')).toMatch(/^pk_dev_/);
    // the presigned request must not leak our credentials to the storage host
    expect(put.url).toBe(PRESIGNED);
    expect(put.headers.get('authorization')).toBeNull();
    expect(put.headers.get('x-platform-key')).toBeNull();
    expect(put.headers.get('content-type')).toBe('image/png');
    expect(put.headers.get('x-amz-meta-a')).toBe('b');
    expect(put.init.body).toBe(blob);
    expect(complete.headers.get('authorization')).toBe('Bearer user-token');
  });

  it('takes filename and content type from a File', async () => {
    const { api, storage } = setup();
    await storage.createUpload({ bucket: 'avatars', file: new File(['abc'], 'pic.png', { type: 'image/png' }) });
    expect(api.calls[0]!.json()).toMatchObject({ filename: 'pic.png', content_type: 'image/png', size: 3 });
  });

  it('reuses one Idempotency-Key when the create call is retried', async () => {
    let n = 0;
    const { api, storage } = setup((r) => {
      if (r.url === PRESIGNED) return new Response(null);
      if (r.url.endsWith('/complete')) return json(object);
      return n++ === 0 ? apiError('unavailable', 503, true) : create();
    });
    await storage.createUpload({ bucket: 'avatars', file: new Blob(['abc'], { type: 'image/png' }), filename: 'a.png' });
    const keys = api.calls.filter((c) => c.url.endsWith('/uploads')).map((c) => c.headers.get('idempotency-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('retries a transient storage failure but never completes after a permanent one', async () => {
    let puts = 0;
    const { api, storage } = setup((r) => {
      if (r.url === PRESIGNED) return puts++ === 0 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 });
      return r.url.endsWith('/complete') ? json(object) : create();
    });
    await storage.createUpload({ bucket: 'avatars', file: new Blob(['abc'], { type: 'image/png' }), filename: 'a.png' });
    expect(puts).toBe(2);

    const denied = setup((r) => (r.url === PRESIGNED ? new Response(null, { status: 403 }) : create()));
    await expect(denied.storage.createUpload({ bucket: 'avatars', file: new Blob(['abc'], { type: 'image/png' }), filename: 'a.png' }))
      .rejects.toMatchObject({ code: 'upload_failed', status: 403, retryable: false });
    expect(denied.api.calls.filter((c) => c.url === PRESIGNED)).toHaveLength(1);
    expect(denied.api.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });

  it('surfaces API rejections (quota, type, product) without retrying and without touching storage', async () => {
    const { api, storage } = setup(() => apiError('quota_exceeded', 422));
    await expect(storage.createUpload({ bucket: 'avatars', file: new Blob(['abc'], { type: 'image/png' }), filename: 'a.png' }))
      .rejects.toMatchObject({ code: 'quota_exceeded', requestId: 'req_test', retryable: false });
    expect(api.calls).toHaveLength(1);
  });

  it('requires a signed-in user and makes no request otherwise', async () => {
    const { api, storage } = setup(undefined, { getAccessToken: async () => null });
    await expect(storage.createUpload({ bucket: 'avatars', file: new Blob(['abc'], { type: 'image/png' }), filename: 'a.png' }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    expect(api.calls).toHaveLength(0);
  });

  it('requires a content type', async () => {
    const { storage } = setup();
    await expect(storage.createUpload({ bucket: 'avatars', file: new Blob(['abc']), filename: 'a.bin' }))
      .rejects.toMatchObject({ code: 'sdk_error' });
  });
});

describe('download / list / delete', () => {
  it('getDownloadUrl posts the object id and optional ttl', async () => {
    const { api, storage } = setup(() => json({ url: 'https://r2.test/dl', expires_at: 'x' }));
    expect(await storage.getDownloadUrl('obj_1', { ttlSeconds: 60 })).toEqual({ url: 'https://r2.test/dl', expires_at: 'x' });
    expect(api.calls[0]!.url).toBe('http://api.test/v1/storage/downloads');
    expect(api.calls[0]!.json()).toEqual({ object_id: 'obj_1', ttl_seconds: 60 });
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer user-token');
  });

  it('list passes bucket, cursor and limit as query parameters', async () => {
    const { api, storage } = setup(() => json({ objects: [object], next_cursor: null }));
    const page = await storage.list({ bucket: 'avatars', cursor: 'c1', limit: 10 });
    expect(page.objects).toHaveLength(1);
    const u = new URL(api.calls[0]!.url);
    expect(u.pathname).toBe('/v1/storage/objects');
    expect(Object.fromEntries(u.searchParams)).toEqual({ bucket: 'avatars', cursor: 'c1', limit: '10' });
  });

  it('delete sends DELETE and accepts an empty response; a missing object is a not_found error', async () => {
    const ok = setup(() => new Response(null, { status: 204 }));
    await expect(ok.storage.delete('obj_1')).resolves.toBeUndefined();
    expect(ok.api.calls[0]!.method).toBe('DELETE');
    expect(ok.api.calls[0]!.url).toBe('http://api.test/v1/storage/objects/obj_1');

    const missing = setup(() => apiError('not_found', 404));
    await expect(missing.storage.delete('obj_x')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(missing.api.calls).toHaveLength(1);
  });
});
