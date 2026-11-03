// POST /v1/logs/batch — PRD §4.4, §19.6.
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCode, fakeQueue, post } from './ingest-helpers.ts';
import { seedProduct, seedServiceKey, type SeededEnv } from './helpers.ts';

const now = () => new Date().toISOString();
const entry = (over: Record<string, unknown> = {}) => ({ level: 'info', timestamp: now(), message: 'hello', ...over });

let a: SeededEnv;
let b: SeededEnv;
let aKey: string;
beforeAll(async () => {
  a = await seedProduct({ productId: 'logs_a' });
  b = await seedProduct({ productId: 'logs_b' });
  aKey = await seedServiceKey(a.productEnvId, ['logs:write']);
});

describe('server logs (service key)', () => {
  it('enqueues entries tagged from the credential, never from the body, with sensitive attributes redacted', async () => {
    const q = fakeQueue();
    const res = await post('/v1/logs/batch', aKey, {
      logs: [entry({ request_id: 'req_client', attributes: { password: 'hunter2', Authorization: 'Bearer x', route: '/x', api_key: 'k' } })],
      product_id: 'logs_b', environment: 'dev',
    }, { overrides: { LOGS_QUEUE: q } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: [] });
    expect(q.bodies).toHaveLength(1);
    expect(q.bodies[0]).toMatchObject({
      product_id: 'logs_a', environment: 'prod', source: 'server', ingest_request_id: res.headers.get('x-request-id'),
      entry: { level: 'info', message: 'hello', request_id: 'req_client', attributes: { password: '[REDACTED]', Authorization: '[REDACTED]', api_key: '[REDACTED]', route: '/x' } },
    });
    expect(JSON.stringify(q.bodies)).not.toContain('hunter2');
  });

  it('accepts valid entries and reports invalid ones by index (partial rejection)', async () => {
    const q = fakeQueue();
    const manyAttrs = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, i]));
    const res = await post('/v1/logs/batch', aKey, {
      logs: [entry(), entry({ level: 'fatal' }), entry({ message: 'x'.repeat(17 * 1024) }), entry({ attributes: manyAttrs }), { nope: true }, entry({ level: 'error' })],
    }, { overrides: { LOGS_QUEUE: q } });
    const body = (await res.json()) as { accepted: number; rejected: Array<{ index: number; code: string }> };
    expect(body.accepted).toBe(2);
    expect(body.rejected.map((r) => [r.index, r.code])).toEqual([
      [1, 'validation_failed'], [2, 'payload_too_large'], [3, 'validation_failed'], [4, 'validation_failed'],
    ]);
    expect(q.bodies.map((m) => m.entry.level)).toEqual(['info', 'error']);
  });

  it('rejects oversized batches with 413 and malformed bodies with 400, enqueueing nothing', async () => {
    const q = fakeQueue();
    const o = { overrides: { LOGS_QUEUE: q } };
    const tooMany = await post('/v1/logs/batch', aKey, { logs: Array.from({ length: 101 }, () => entry()) }, o);
    expect([tooMany.status, await errorCode(tooMany)]).toEqual([413, 'payload_too_large']);
    const bigBody = await post('/v1/logs/batch', aKey, { logs: [entry({ attributes: { blob: 'x'.repeat(600 * 1024) } })] }, o);
    expect([bigBody.status, await errorCode(bigBody)]).toEqual([413, 'payload_too_large']);
    const notJson = await post('/v1/logs/batch', aKey, '{oops', { ...o, raw: true });
    expect([notJson.status, await errorCode(notJson)]).toEqual([400, 'invalid_request']);
    const wrongShape = await post('/v1/logs/batch', aKey, { logs: [] }, o);
    expect([wrongShape.status, await errorCode(wrongShape)]).toEqual([400, 'validation_failed']);
    expect(q.calls).toBe(0);
  });

  it('returns a retryable 503 when the queue is down', async () => {
    const res = await post('/v1/logs/batch', aKey, { logs: [entry()] }, { overrides: { LOGS_QUEUE: fakeQueue({ failOnCall: 1 }) } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unavailable', retryable: true } });
  });

  it('rate limits per key with 429 + Retry-After', async () => {
    const q = fakeQueue();
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const res = await post('/v1/logs/batch', aKey, { logs: [entry()] }, { overrides: { LOGS_QUEUE: q, INGEST_LIMITER: limiter } });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited', retryable: true } });
    expect(q.calls).toBe(0);
    // The limiter key is per credential, so one product's traffic can't exhaust another's budget.
    await post('/v1/logs/batch', await seedServiceKey(b.productEnvId, ['logs:write']), { logs: [entry()] }, { overrides: { INGEST_LIMITER: limiter } });
    expect(new Set(keys).size).toBe(2);
  });
});

describe('credentials and isolation', () => {
  it('requires a key, the logs:write scope, and an active product', async () => {
    const o = { overrides: { LOGS_QUEUE: fakeQueue() } };
    expect(await errorCode(await post('/v1/logs/batch', null, { logs: [entry()] }, o))).toBe('unauthenticated');
    const eventsOnly = await seedServiceKey(a.productEnvId, ['events:write']);
    expect(await errorCode(await post('/v1/logs/batch', eventsOnly, { logs: [entry()] }, o))).toBe('forbidden');
    const revoked = await seedServiceKey(a.productEnvId, ['logs:write'], { revoked: true });
    expect(await errorCode(await post('/v1/logs/batch', revoked, { logs: [entry()] }, o))).toBe('unauthenticated');
    const d = await seedProduct({ productId: 'logs_disabled', status: 'disabled' });
    expect(await errorCode(await post('/v1/logs/batch', await seedServiceKey(d.productEnvId, ['logs:write']), { logs: [entry()] }, o))).toBe('product_disabled');
  });

  it("isolates products: each key's logs are tagged only with its own product", async () => {
    const q = fakeQueue();
    const bKey = await seedServiceKey(b.productEnvId, ['logs:write']);
    await post('/v1/logs/batch', aKey, { logs: [entry({ message: 'from a' })] }, { overrides: { LOGS_QUEUE: q } });
    await post('/v1/logs/batch', bKey, { logs: [entry({ message: 'from b' })] }, { overrides: { LOGS_QUEUE: q } });
    expect(q.bodies.map((m) => [m.entry.message, m.product_id])).toEqual([['from a', 'logs_a'], ['from b', 'logs_b']]);
  });
});

describe('browser error reports (publishable key)', () => {
  it('are accepted as untrusted browser-sourced errors; client-supplied level and attributes are ignored', async () => {
    const q = fakeQueue();
    const res = await post('/v1/logs/batch', a.publishableKey, {
      logs: [{ message: 'boom', stack: 'at x', url: 'https://a.example/p', timestamp: now(), level: 'info', attributes: { audit: true }, event_name: 'admin.login' }],
    }, { overrides: { LOGS_QUEUE: q } });
    expect(res.status).toBe(202);
    expect(q.bodies[0]).toMatchObject({
      product_id: 'logs_a', source: 'browser',
      entry: { level: 'error', event_name: 'browser_error', message: 'boom', attributes: { stack: 'at x', url: 'https://a.example/p' } },
    });
    expect(q.bodies[0].entry.attributes.audit).toBeUndefined();
  });

  it('enforce the 8 KB report limit per entry and reject malformed reports', async () => {
    const q = fakeQueue();
    const res = await post('/v1/logs/batch', a.publishableKey, {
      logs: [{ message: 'ok', timestamp: now() }, { message: 'big', stack: 'x'.repeat(4000), url: 'u'.repeat(1000), timestamp: now(), request_id: 'r'.repeat(100), extra: 'y'.repeat(4000) }, { timestamp: now() }],
    }, { overrides: { LOGS_QUEUE: q } });
    const body = (await res.json()) as { accepted: number; rejected: Array<{ index: number; code: string }> };
    expect(body.accepted).toBe(1);
    expect(body.rejected.map((r) => [r.index, r.code])).toEqual([[1, 'payload_too_large'], [2, 'validation_failed']]);
  });
});
