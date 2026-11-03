import { EVENTS_MAX_BATCH_BYTES, EVENTS_MAX_PER_BATCH, EventInput } from '@z-cloudbase/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics, type AnalyticsOptions } from '../src/analytics.ts';
import { apiError, baseConfig, fakeFetch, json, memoryStore, type Recorded } from './helpers.ts';

const OK = () => json({ accepted: 1, duplicate: 0, rejected: [] });
const eventsOf = (r: Recorded): any[] => r.json().events;

let local: ReturnType<typeof memoryStore>;
let doc: EventTarget & { visibilityState: string };
let win: EventTarget;

beforeEach(() => {
  local = memoryStore();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  win = new EventTarget();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(handler: (r: Recorded) => Response | Promise<Response> = OK, opts: AnalyticsOptions = {}, auth?: Parameters<typeof createAnalytics>[1]) {
  const api = fakeFetch(handler);
  const analytics = createAnalytics(baseConfig({ fetch: api.fetch }), auth, { flushIntervalMs: 0, ...opts });
  return { api, analytics };
}

describe('analytics payload', () => {
  it('buffers until flush, then posts one batch that satisfies the EventInput contract', async () => {
    const { api, analytics } = setup();
    analytics.track('feature_used', { feature: 'editor', count: 3, ok: true, none: null });
    analytics.track('page_view');
    expect(api.calls).toHaveLength(0);

    await analytics.flush();

    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    expect(call.url).toBe('http://api.test/v1/events/batch');
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-platform-key')).toMatch(/^pk_dev_/);
    expect(call.headers.get('authorization')).toBeNull();
    const events = eventsOf(call);
    expect(events).toHaveLength(2);
    for (const e of events) expect(EventInput.safeParse(e).success).toBe(true);
    expect(events[0].properties).toEqual({ feature: 'editor', count: 3, ok: true, none: null });
    // identity fields are the server's job
    for (const e of events) expect(e).not.toHaveProperty('user_id');
    expect(events[0].session_id).toBe(events[1].session_id);
  });

  it('drops bad input silently instead of throwing into the host app', async () => {
    const { api, analytics } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      analytics.track('Bad Name');
      analytics.track('');
      // 50 keys of 1 KiB each: over the 8 KiB properties limit
      analytics.track('big', Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'y'.repeat(1024)])));
      analytics.track('has_object', { nested: { a: 1 }, list: [1], fn: () => 1, circular, fine: 'yes' });
    }).not.toThrow();
    await analytics.flush();
    const events = eventsOf(api.calls[0]!);
    expect(events.map((e) => e.event_name)).toEqual(['has_object']);
    expect(events[0].properties).toEqual({ fine: 'yes' });
  });

  it('samples events at the configured rate', async () => {
    const { api, analytics } = setup(OK, { sampleRate: 0.5 });
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValueOnce(0.9).mockReturnValueOnce(0.1);
    analytics.track('dropped');
    analytics.track('kept');
    rnd.mockRestore();
    await analytics.flush();
    expect(eventsOf(api.calls[0]!).map((e) => e.event_name)).toEqual(['kept']);
  });
});

describe('batching limits', () => {
  it('never sends more than EVENTS_MAX_PER_BATCH events per request and loses none', async () => {
    const { api, analytics } = setup();
    for (let i = 0; i < 250; i++) analytics.track('tick', { i });
    await analytics.flush();
    const sizes = api.calls.map((c) => eventsOf(c).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(EVENTS_MAX_PER_BATCH);
    const ids = api.calls.flatMap((c) => eventsOf(c).map((e) => e.event_id));
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  it('keeps every request body within EVENTS_MAX_BATCH_BYTES', async () => {
    const { api, analytics } = setup();
    const filler = 'z'.repeat(1000);
    for (let i = 0; i < 90; i++) analytics.track('heavy', Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`k${k}`, filler])));
    await analytics.flush();
    expect(api.calls.length).toBeGreaterThan(1);
    for (const c of api.calls) expect(new TextEncoder().encode(c.body!).length).toBeLessThanOrEqual(EVENTS_MAX_BATCH_BYTES);
    expect(api.calls.reduce((n, c) => n + eventsOf(c).length, 0)).toBe(90);
  });

  it('flushes on its own when a full batch is queued', async () => {
    const { api, analytics } = setup();
    for (let i = 0; i < EVENTS_MAX_PER_BATCH; i++) analytics.track('tick');
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    analytics.destroy();
  });

  it('flushes periodically', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, analytics } = setup(OK, { flushIntervalMs: 1000 });
    analytics.track('tick');
    expect(api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(1);
    analytics.destroy();
  });
});

describe('retry and dedupe', () => {
  it('resends the same event_ids when a retryable failure is retried', async () => {
    let n = 0;
    const { api, analytics } = setup(() => (n++ < 2 ? apiError('unavailable', 503, true) : OK()));
    analytics.track('a');
    analytics.track('b');
    await analytics.flush();
    expect(api.calls).toHaveLength(3);
    const ids = api.calls.map((c) => eventsOf(c).map((e) => e.event_id));
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
    expect(api.calls[2]!.body).toBe(api.calls[0]!.body);
  });

  it('retries network errors, and keeps events (same ids) for the next flush when still failing', async () => {
    let down = true;
    const api = fakeFetch(() => (down ? Promise.reject(new TypeError('offline')) : OK()));
    const analytics = createAnalytics(baseConfig({ fetch: api.fetch }), undefined, { flushIntervalMs: 0, maxRetries: 2 });
    analytics.track('a');
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(3); // 1 + 2 retries
    const first = eventsOf(api.calls[0]!)[0].event_id;

    down = false;
    await analytics.flush();
    expect(api.calls).toHaveLength(4);
    expect(eventsOf(api.calls[3]!).map((e) => e.event_id)).toEqual([first]);
  });

  it('does not retry a non-retryable 4xx and drops that batch', async () => {
    const { api, analytics } = setup(() => apiError('validation_failed', 400));
    analytics.track('a');
    await analytics.flush();
    expect(api.calls).toHaveLength(1);
    await analytics.flush();
    expect(api.calls).toHaveLength(1); // nothing left to send
  });

  it('does not retry 401 with a bad key either', async () => {
    const { api, analytics } = setup(() => apiError('unauthenticated', 401));
    analytics.track('a');
    await analytics.flush();
    expect(api.calls).toHaveLength(1);
  });

  it('retries on 429 rate limits', async () => {
    let n = 0;
    const { api, analytics } = setup(() => (n++ === 0 ? apiError('rate_limited', 429, true) : OK()));
    analytics.track('a');
    await analytics.flush();
    expect(api.calls).toHaveLength(2);
  });
});

describe('anonymous id and sessions', () => {
  it('persists a product-scoped anonymous id and reuses it across instances', async () => {
    const a = setup();
    a.analytics.track('x');
    await a.analytics.flush();
    const id = eventsOf(a.api.calls[0]!)[0].anonymous_id;
    expect([...local.map.keys()]).toEqual(['zcb.product_a.dev.anonymous_id']);

    const b = setup();
    b.analytics.track('x');
    await b.analytics.flush();
    expect(eventsOf(b.api.calls[0]!)[0].anonymous_id).toBe(id);
  });

  it('gives another product on the same origin a different id under a different key', async () => {
    const a = setup();
    a.analytics.track('x');
    const api = fakeFetch(OK);
    const other = createAnalytics(baseConfig({ fetch: api.fetch, productId: 'product_b' }), undefined, { flushIntervalMs: 0 });
    other.track('x');
    await Promise.all([a.analytics.flush(), other.flush()]);
    const idA = eventsOf(a.api.calls[0]!)[0].anonymous_id;
    const idB = eventsOf(api.calls[0]!)[0].anonymous_id;
    expect(idA).not.toBe(idB);
    expect([...local.map.keys()].sort()).toEqual([
      'zcb.product_a.dev.anonymous_id', 'zcb.product_b.dev.anonymous_id',
    ]);
  });

  it('reset() starts a new anonymous visitor and session', async () => {
    const { api, analytics } = setup();
    analytics.track('before');
    analytics.reset();
    analytics.track('after');
    await analytics.flush();
    const [before, after] = eventsOf(api.calls[0]!);
    expect(after.anonymous_id).not.toBe(before.anonymous_id);
    expect(after.session_id).not.toBe(before.session_id);
    expect(local.map.get('zcb.product_a.dev.anonymous_id')).toBe(after.anonymous_id);
  });

  it('starts a new session after 30 minutes of inactivity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { api, analytics } = setup();
    analytics.track('a');
    vi.setSystemTime(Date.now() + 31 * 60_000);
    analytics.track('b');
    await analytics.flush();
    const [a, b] = eventsOf(api.calls[0]!);
    expect(b.session_id).not.toBe(a.session_id);
    expect(b.anonymous_id).toBe(a.anonymous_id);
  });

  it('still works when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} });
    const { api, analytics } = setup();
    analytics.track('a');
    analytics.track('b');
    await analytics.flush();
    const [a, b] = eventsOf(api.calls[0]!);
    expect(a.anonymous_id).toBeTruthy();
    expect(b.anonymous_id).toBe(a.anonymous_id);
  });
});

describe('identify', () => {
  const auth = { getAccessToken: vi.fn(async () => 'user-token'), peekAccessToken: vi.fn(() => 'user-token' as string | null) };

  it('sends no credentials of the user until identify(), then only the bearer token', async () => {
    const { api, analytics } = setup(OK, {}, auth);
    analytics.track('anon');
    await analytics.flush();
    expect(api.calls[0]!.headers.get('authorization')).toBeNull();

    analytics.identify();
    analytics.track('known');
    await analytics.flush();
    expect(api.calls[1]!.headers.get('authorization')).toBe('Bearer user-token');
    expect(JSON.stringify(api.calls[1]!.json())).not.toContain('user-token');
    expect(eventsOf(api.calls[1]!)[0]).not.toHaveProperty('user_id');
  });

  it('reset() stops sending the token', async () => {
    const { api, analytics } = setup(OK, {}, auth);
    analytics.identify();
    analytics.reset();
    analytics.track('x');
    await analytics.flush();
    expect(api.calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('falls back to anonymous when the user is signed out', async () => {
    const out = { getAccessToken: vi.fn(async () => null), peekAccessToken: vi.fn(() => null) };
    const { api, analytics } = setup(OK, {}, out);
    analytics.identify();
    analytics.track('x');
    await analytics.flush();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.headers.get('authorization')).toBeNull();
  });
});

describe('page lifecycle', () => {
  it('flushes with fetch keepalive and starts the request synchronously when the page is hidden', () => {
    const { api, analytics } = setup();
    analytics.track('bye');
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(api.calls).toHaveLength(1); // no await needed
    expect(api.calls[0]!.init.keepalive).toBe(true);
    expect(eventsOf(api.calls[0]!)).toHaveLength(1);
    analytics.destroy();
  });

  it('flushes with keepalive on pagehide and uses the in-memory token when identified', () => {
    const auth = { getAccessToken: vi.fn(async () => 'slow'), peekAccessToken: vi.fn(() => 'peeked') };
    const { api, analytics } = setup(OK, {}, auth);
    analytics.identify();
    analytics.track('bye');
    win.dispatchEvent(new Event('pagehide'));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.init.keepalive).toBe(true);
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer peeked');
    analytics.destroy();
  });

  it('keeps keepalive bodies under the 64 KiB browser limit', () => {
    const { api, analytics } = setup();
    for (let i = 0; i < 60; i++) analytics.track('big', { blob: 'q'.repeat(1000) });
    win.dispatchEvent(new Event('pagehide'));
    expect(api.calls.length).toBeGreaterThan(1);
    for (const c of api.calls) expect(new TextEncoder().encode(c.body!).length).toBeLessThan(64 * 1024);
    analytics.destroy();
  });

  it('does not flush when the page becomes visible again, and stops listening after destroy()', () => {
    const { api, analytics } = setup();
    analytics.track('a');
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(api.calls).toHaveLength(0);
    analytics.destroy();
    win.dispatchEvent(new Event('pagehide'));
    expect(api.calls).toHaveLength(0);
  });
});
