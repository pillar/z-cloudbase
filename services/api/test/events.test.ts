// POST /v1/events/batch — PRD §4.5, §19.6, §19.8.
import { newId, uuidv7 } from '@z-cloudbase/contracts';
import { userKey } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCode, fakeQueue, post } from './ingest-helpers.ts';
import { seedMembership, seedProduct, seedServiceKey, userFor, type SeededEnv } from './helpers.ts';

const ev = (over: Record<string, unknown> = {}) => ({
  event_id: uuidv7(), event_name: 'page_view', occurred_at: new Date().toISOString(), anonymous_id: 'anon-1', properties: { path: '/home' }, ...over,
});
const send = (key: string | null, events: unknown[], q = fakeQueue(), headers?: Record<string, string>) =>
  post('/v1/events/batch', key, { events }, { overrides: { EVENTS_QUEUE: q }, headers });
const json = async (res: Response) => (await res.json()) as any;
const dedupeCount = async (productEnvId: string) =>
  (await env.INGEST_DB.prepare('SELECT COUNT(*) AS n FROM event_dedup WHERE product_env_id = ?').bind(productEnvId).first<{ n: number }>())!.n;

let a: SeededEnv;
let b: SeededEnv;
beforeAll(async () => {
  a = await seedProduct({ productId: 'ev_a' });
  b = await seedProduct({ productId: 'ev_b' });
});

describe('accepting events', () => {
  it('derives product/env from the key and ignores identity fields in the body', async () => {
    const q = fakeQueue();
    const e = ev({ product_id: 'ev_b', environment: 'dev' });
    // A browser cannot name a user (PRD §21.7): that event is rejected, the rest of the batch is kept.
    const forged = ev({ user_id: 'usr_forged' });
    const res = await send(a.publishableKey, [e, forged], q);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, duplicate: 0, rejected: [{ index: 1, code: 'user_id_not_allowed', message: expect.any(String) }] });
    expect(q.events).toHaveLength(1);
    expect(q.events[0]).toMatchObject({ v: 2, product_id: 'ev_a', environment: 'prod', user_key: null, event: { event_id: e.event_id, event_name: 'page_view', anonymous_id: 'anon-1' } });
    expect(JSON.stringify(q.bodies)).not.toContain('usr_forged');
    expect(JSON.stringify(q.bodies)).not.toContain('ev_b');
  });

  it('pseudonymises a verified user as HMAC(user_id, product salt); the raw user_id never reaches the queue', async () => {
    const q = fakeQueue();
    const u = await userFor(a);
    const res = await send(a.publishableKey, [ev()], q, { Authorization: `Bearer ${u.token}` });
    expect(res.status).toBe(202);
    expect(q.events[0].user_key).toBe(await userKey(u.userId, a.salt));
    expect(JSON.stringify(q.events)).not.toContain(u.userId);
  });

  it('accepts service keys with events:write', async () => {
    const key = await seedServiceKey(a.productEnvId, ['events:write']);
    const q = fakeQueue();
    expect((await send(key, [ev()], q)).status).toBe(202);
    expect(q.events[0]).toMatchObject({ product_id: 'ev_a', user_key: null });
  });
});

describe('credentials and isolation', () => {
  it('rejects missing keys, service keys without the scope, and revoked keys', async () => {
    const q = fakeQueue();
    expect(await errorCode(await send(null, [ev()], q))).toBe('unauthenticated');
    expect(await errorCode(await send(await seedServiceKey(a.productEnvId, ['logs:write']), [ev()], q))).toBe('forbidden');
    expect(await errorCode(await send(await seedServiceKey(a.productEnvId, ['events:write'], { revoked: true }), [ev()], q))).toBe('unauthenticated');
    expect(q.calls).toBe(0);
  });

  it("rejects product A's user token with product B's key and records nothing", async () => {
    const q = fakeQueue();
    const u = await userFor(a);
    await seedMembership(u.userId, b.productId);
    const before = await dedupeCount(b.productEnvId);
    const res = await send(b.publishableKey, [ev()], q, { Authorization: `Bearer ${u.token}` });
    expect(res.status).toBe(401);
    expect(await errorCode(res.clone())).toBe('invalid_token');
    expect(JSON.stringify(await res.json())).not.toContain(u.userId);
    expect(q.calls).toBe(0);
    expect(await dedupeCount(b.productEnvId)).toBe(before);
  });

  it('rejects invalid tokens and users without membership', async () => {
    expect(await errorCode(await send(a.publishableKey, [ev()], fakeQueue(), { Authorization: 'Bearer abc.def.ghi' }))).toBe('invalid_token');
    const u = await userFor(a);
    await seedMembership(u.userId, a.productId, 'revoked');
    expect(await errorCode(await send(a.publishableKey, [ev()], fakeQueue(), { Authorization: `Bearer ${u.token}` }))).toBe('membership_required');
  });

  it('does not dedupe across products: the same event_id counts once in each', async () => {
    const e = ev();
    const q = fakeQueue();
    expect(await json(await send(a.publishableKey, [e], q))).toMatchObject({ accepted: 1, duplicate: 0 });
    expect(await json(await send(b.publishableKey, [e], q))).toMatchObject({ accepted: 1, duplicate: 0 });
    expect(q.events.map((m) => m.product_id)).toEqual(['ev_a', 'ev_b']);
  });
});

describe('validation and limits', () => {
  it('rejects invalid events individually and keeps the valid ones', async () => {
    const q = fakeQueue();
    const day = 24 * 3600 * 1000;
    const manyProps = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
    const bigProps = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]));
    const res = await send(a.publishableKey, [
      ev(), // 0 ok
      ev({ event_name: 'Bad Name' }), // 1
      ev({ occurred_at: new Date(Date.now() - 8 * day).toISOString() }), // 2 too old
      ev({ occurred_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), // 3 too far ahead
      ev({ properties: manyProps }), // 4
      ev({ properties: bigProps }), // 5
      ev({ properties: { nested: { a: 1 } } }), // 6 non-scalar
      ev({ event_id: 'not-a-uuid' }), // 7
      ev({ occurred_at: new Date(Date.now() - 6 * day).toISOString() }), // 8 ok, inside window
    ], q);
    const body = await json(res);
    expect(body.accepted).toBe(2);
    expect(body.rejected.map((r: any) => [r.index, r.code])).toEqual([
      [1, 'validation_failed'], [2, 'occurred_at_out_of_range'], [3, 'occurred_at_out_of_range'],
      [4, 'validation_failed'], [5, 'payload_too_large'], [6, 'validation_failed'], [7, 'validation_failed'],
    ]);
    expect(q.events).toHaveLength(2);
  });

  it('rejects oversized batches (413) and malformed bodies (400) without side effects', async () => {
    const q = fakeQueue();
    const before = await dedupeCount(a.productEnvId);
    const tooMany = await send(a.publishableKey, Array.from({ length: 101 }, () => ev()), q);
    expect([tooMany.status, await errorCode(tooMany)]).toEqual([413, 'payload_too_large']);
    const bigBody = await send(a.publishableKey, [ev({ properties: { blob: 'x'.repeat(300 * 1024) } })], q);
    expect([bigBody.status, await errorCode(bigBody)]).toEqual([413, 'payload_too_large']);
    const notJson = await post('/v1/events/batch', a.publishableKey, 'nope', { raw: true, overrides: { EVENTS_QUEUE: q } });
    expect([notJson.status, await errorCode(notJson)]).toEqual([400, 'invalid_request']);
    const noEvents = await post('/v1/events/batch', a.publishableKey, { events: [] }, { overrides: { EVENTS_QUEUE: q } });
    expect([noEvents.status, await errorCode(noEvents)]).toEqual([400, 'validation_failed']);
    expect(q.calls).toBe(0);
    expect(await dedupeCount(a.productEnvId)).toBe(before);
  });

  it('rate limits per key with 429', async () => {
    const q = fakeQueue();
    const res = await post('/v1/events/batch', a.publishableKey, { events: [ev()] }, {
      overrides: { EVENTS_QUEUE: q, INGEST_LIMITER: { limit: async () => ({ success: false }) } },
    });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(q.calls).toBe(0);
  });
});

describe('deduplication (24h window)', () => {
  it('counts a repeated event_id once, within one batch and across batches', async () => {
    const q = fakeQueue();
    const e = ev();
    expect(await json(await send(a.publishableKey, [e, e, ev()], q))).toMatchObject({ accepted: 2, duplicate: 1 });
    expect(await json(await send(a.publishableKey, [e], q))).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(q.events.filter((m) => m.event.event_id === e.event_id)).toHaveLength(1);
  });

  it('takes over an expired dedupe row but not a live one', async () => {
    const e = ev();
    await env.INGEST_DB.prepare('INSERT INTO event_dedup (product_env_id, event_id, expires_at) VALUES (?, ?, ?)')
      .bind(a.productEnvId, e.event_id, Date.now() - 1000).run();
    const q = fakeQueue();
    expect(await json(await send(a.publishableKey, [e], q))).toMatchObject({ accepted: 1, duplicate: 0 });
    expect(await json(await send(a.publishableKey, [e], q))).toMatchObject({ accepted: 0, duplicate: 1 });
  });

  it('releases dedupe claims when the queue is down (503), so the client retry is accepted, not lost', async () => {
    const events = [ev(), ev()];
    const failing = fakeQueue({ failOnCall: 1 });
    const res = await send(a.publishableKey, events, failing);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unavailable', retryable: true } });
    expect(failing.events).toHaveLength(0);

    const healthy = fakeQueue();
    expect(await json(await send(a.publishableKey, events, healthy))).toMatchObject({ accepted: 2, duplicate: 0 });
    expect(healthy.events).toHaveLength(2);
  });

  it('on a partial enqueue failure keeps claims only for events that were enqueued', async () => {
    // ~8.3 KB each, 30 events > one 200 KB queue chunk, so the second sendBatch fails.
    const props = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]));
    const events = Array.from({ length: 30 }, () => ev({ properties: props }));
    const q = fakeQueue({ failOnCall: 2 });
    expect((await send(a.publishableKey, events, q)).status).toBe(503);
    expect(q.events.length).toBeGreaterThan(0);
    expect(q.events.length).toBeLessThan(30);

    const retry = fakeQueue();
    const body = await json(await send(a.publishableKey, events, retry));
    expect(body.duplicate).toBe(q.events.length);
    expect(body.accepted).toBe(30 - q.events.length);
    const ids = [...q.events, ...retry.events].map((m) => m.event.event_id);
    expect(new Set(ids).size).toBe(30);
  });
});

describe('event registry', () => {
  const register = (productEnvId: string, name: string) =>
    env.DB.prepare('INSERT INTO event_schemas (id, product_env_id, event_name, schema_version, json_schema, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(newId('evs'), productEnvId, name, '{}', Date.now()).run();

  it('warns about unregistered events in dev and staging but still accepts them', async () => {
    const dev = await seedProduct({ productId: 'ev_dev', env: 'dev' });
    await register(dev.productEnvId, 'known');
    const q = fakeQueue();
    const body = await json(await send(dev.publishableKey, [ev({ event_name: 'known' }), ev({ event_name: 'mystery' })], q));
    expect(body.accepted).toBe(2);
    expect(body.warnings).toEqual([{ index: 1, code: 'unknown_event', message: expect.stringContaining('mystery') }]);
  });

  it('in prod follows unknown_event_policy: accept by default, reject when configured', async () => {
    const prod = await seedProduct({ productId: 'ev_prod' });
    await register(prod.productEnvId, 'known');
    const accepting = await json(await send(prod.publishableKey, [ev({ event_name: 'mystery' })]));
    expect(accepting).toMatchObject({ accepted: 1, rejected: [] });

    await env.DB.prepare(`UPDATE product_environments SET unknown_event_policy = 'reject' WHERE id = ?`).bind(prod.productEnvId).run();
    const q = fakeQueue();
    const rejecting = await json(await send(prod.publishableKey, [ev({ event_name: 'known' }), ev({ event_name: 'mystery' })], q));
    expect(rejecting.accepted).toBe(1);
    expect(rejecting.rejected).toEqual([{ index: 1, code: 'unknown_event', message: expect.any(String) }]);
    expect(q.events.map((m) => m.event.event_name)).toEqual(['known']);
  });

  it("does not see another product's registered events", async () => {
    const x = await seedProduct({ productId: 'ev_reg_x' });
    const y = await seedProduct({ productId: 'ev_reg_y' });
    await env.DB.prepare(`UPDATE product_environments SET unknown_event_policy = 'reject' WHERE id = ?`).bind(y.productEnvId).run();
    await register(x.productEnvId, 'only_x');
    const res = await json(await send(y.publishableKey, [ev({ event_name: 'only_x' })]));
    expect(res.accepted).toBe(0);
    expect(res.rejected[0].code).toBe('unknown_event');
  });
});
