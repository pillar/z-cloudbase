import { EVENTS_MAX_PER_BATCH, EventInput } from '@z-cloudbase/contracts';
import { describe, expect, it } from 'vitest';
import { createServerClient } from '../src/index.ts';
import { SK, apiError, baseConfig, fakeFetch, json, type Recorded } from './helpers.ts';

const OK = () => json({ accepted: 1, duplicate: 0, rejected: [] });
const eventsOf = (r: Recorded): any[] => r.json().events;

function setup(handler: (r: Recorded) => Response | Promise<Response> = OK) {
  const api = fakeFetch(handler);
  return { api, server: createServerClient(baseConfig({ fetch: api.fetch })) };
}

describe('analytics.trackServerEvent', () => {
  it('sends a contract-valid event with the service key and no user identity', async () => {
    const { api, server } = setup();
    server.analytics.trackServerEvent('invoice_paid', { amount: 49, plan: 'pro', nested: { dropped: true } }, { anonymousId: 'job-7' });
    await server.analytics.flush();
    const call = api.calls[0]!;
    expect(call.url).toBe('http://api.test/v1/events/batch');
    expect(call.headers.get('x-platform-key')).toBe(SK);
    expect(call.headers.get('authorization')).toBeNull();
    const [e] = eventsOf(call);
    expect(EventInput.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ event_name: 'invoice_paid', properties: { amount: 49, plan: 'pro' }, anonymous_id: 'job-7' });
    expect(e).not.toHaveProperty('user_id');
  });

  it('keeps event_id stable across retries and honours a caller-chosen id', async () => {
    let n = 0;
    const { api, server } = setup(() => (n++ === 0 ? apiError('unavailable', 503, true) : OK()));
    server.analytics.trackServerEvent('job_done', {}, { eventId: '0b0f6a6e-7d0c-4f5c-9a77-0d6d6a1b2c3d' });
    await server.analytics.flush();
    expect(api.calls).toHaveLength(2);
    expect(eventsOf(api.calls[0]!)[0].event_id).toBe('0b0f6a6e-7d0c-4f5c-9a77-0d6d6a1b2c3d');
    expect(api.calls[1]!.body).toBe(api.calls[0]!.body);
  });

  it('does not retry a non-retryable response', async () => {
    const { api, server } = setup(() => apiError('forbidden_product', 403));
    server.analytics.trackServerEvent('x');
    await server.analytics.flush();
    expect(api.calls).toHaveLength(1);
  });

  it('rejects invalid names and oversized properties up front', () => {
    const { server } = setup();
    expect(() => server.analytics.trackServerEvent('Bad Name')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'y'.repeat(1024)]));
    expect(() => server.analytics.trackServerEvent('ok_name', big)).toThrow(expect.objectContaining({ code: 'validation_failed' }));
  });

  it('track() attributes an event to a member with userId (the API checks membership)', async () => {
    const { api, server } = setup();
    server.analytics.track('order_shipped', { items: 2 }, { userId: 'usr_123', eventId: '0b0f6a6e-7d0c-4f5c-9a77-0d6d6a1b2c3e' });
    await server.flush();
    const [e] = eventsOf(api.calls[0]!);
    expect(EventInput.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ event_name: 'order_shipped', user_id: 'usr_123', event_id: '0b0f6a6e-7d0c-4f5c-9a77-0d6d6a1b2c3e' });
  });

  it('setUserProperties posts user_id + properties and surfaces API errors', async () => {
    const { api, server } = setup((r) => (r.json().user_id === 'usr_ok' ? json({ properties: { plan: 'pro' } }) : apiError('membership_required', 403)));
    expect(await server.analytics.setUserProperties('usr_ok', { plan: 'pro' })).toEqual({ plan: 'pro' });
    expect(api.calls[0]!.url).toBe('http://api.test/v1/events/user-properties');
    expect(api.calls[0]!.json()).toEqual({ user_id: 'usr_ok', properties: { plan: 'pro' } });
    await expect(server.analytics.setUserProperties('usr_other', { plan: 'x' })).rejects.toMatchObject({ code: 'membership_required' });
  });

  it('batches at most EVENTS_MAX_PER_BATCH events per request', async () => {
    const { api, server } = setup();
    for (let i = 0; i < 230; i++) server.analytics.trackServerEvent('tick', { i });
    await server.flush();
    expect(Math.max(...api.calls.map((c) => eventsOf(c).length))).toBeLessThanOrEqual(EVENTS_MAX_PER_BATCH);
    expect(api.calls.reduce((n, c) => n + eventsOf(c).length, 0)).toBe(230);
  });
});

describe('storage', () => {
  const PRESIGNED = 'https://r2.test/bucket/obj_9?X-Amz-Signature=abc';
  const object = { id: 'obj_9', bucket: 'reports', filename: 'r.pdf', content_type: 'application/pdf', size: 4, status: 'available', created_at: 'x' };
  const routes = (r: Recorded) => {
    if (r.url === PRESIGNED) return new Response(null, { status: 200 });
    if (r.url.endsWith('/complete')) return json(object);
    return json({ object_id: 'obj_9', method: 'PUT', url: PRESIGNED, headers: { 'Content-Type': 'application/pdf' }, expires_at: 'x' });
  };

  it('uploads bytes: create, PUT to the presigned URL without our key, complete', async () => {
    const { api, server } = setup(routes);
    const result = await server.storage.createUpload({
      bucket: 'reports', filename: 'r.pdf', contentType: 'application/pdf', body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(result).toEqual(object);
    const [create, put, complete] = api.calls as [Recorded, Recorded, Recorded];
    expect(create.json()).toEqual({ bucket: 'reports', filename: 'r.pdf', content_type: 'application/pdf', size: 4 });
    expect(create.headers.get('x-platform-key')).toBe(SK);
    expect(create.headers.get('idempotency-key')).toBeTruthy();
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(PRESIGNED);
    expect(put.headers.get('x-platform-key')).toBeNull();
    expect(put.headers.get('authorization')).toBeNull();
    expect(complete.url).toBe('http://api.test/v1/storage/uploads/obj_9/complete');
    expect(complete.headers.get('x-platform-key')).toBe(SK);
  });

  it('does not complete after a rejected upload and reports upload_failed', async () => {
    const { api, server } = setup((r) => (r.url === PRESIGNED ? new Response(null, { status: 403 }) : routes(r)));
    await expect(server.storage.createUpload({
      bucket: 'reports', filename: 'r.pdf', contentType: 'application/pdf', body: new Blob(['abcd']),
    })).rejects.toMatchObject({ code: 'upload_failed', status: 403, retryable: false });
    expect(api.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });

  it('surfaces API rejections such as an unsupported type or quota without touching storage', async () => {
    const { api, server } = setup(() => apiError('unsupported_type', 422));
    await expect(server.storage.createUpload({
      bucket: 'reports', filename: 'r.exe', contentType: 'application/x-msdownload', body: new Blob(['abcd']),
    })).rejects.toMatchObject({ code: 'unsupported_type', requestId: 'req_test' });
    expect(api.calls).toHaveLength(1);
  });

  it('getDownloadUrl posts the object id and ttl', async () => {
    const { api, server } = setup(() => json({ url: 'https://r2.test/dl', expires_at: 'x' }));
    expect(await server.storage.getDownloadUrl('obj_9', { ttlSeconds: 120 })).toEqual({ url: 'https://r2.test/dl', expires_at: 'x' });
    expect(api.calls[0]!.json()).toEqual({ object_id: 'obj_9', ttl_seconds: 120 });
    expect(api.calls[0]!.headers.get('x-platform-key')).toBe(SK);
  });

  it('does not leak a cross-product object: a 404 from the API stays a not_found error', async () => {
    const { server } = setup(() => apiError('not_found', 404));
    await expect(server.storage.getDownloadUrl('obj_of_product_b')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});
