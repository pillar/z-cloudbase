import { LOGS_MAX_BATCH_BYTES, LOGS_MAX_PER_BATCH, LOG_MAX_ENTRY_BYTES, LogEntryInput } from '@z-cloudbase/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type PlatformError } from '../src/index.ts';
import { SK, apiError, baseConfig, fakeFetch, json, type Recorded } from './helpers.ts';

const OK = () => json({ accepted: 1, rejected: [] });
const logsOf = (r: Recorded): any[] => r.json().logs;

afterEach(() => vi.useRealTimers());

function setup(handler: (r: Recorded) => Response | Promise<Response> = OK, over: Parameters<typeof baseConfig>[0] & { onError?: (e: PlatformError) => void } = {}) {
  const api = fakeFetch(handler);
  const server = createServerClient(baseConfig({ fetch: api.fetch, ...over }));
  return { api, server, logs: server.logs };
}

describe('server logs', () => {
  it('buffers, then sends one batch of valid entries with the service key', async () => {
    const { api, logs } = setup();
    logs.info('user signed up', { plan: 'pro', seats: 3 }, { request_id: 'req_1', trace_id: 't1' });
    logs.warn('slow query');
    logs.error('boom', { code: 500 }, { event_name: 'db_error' });
    expect(api.calls).toHaveLength(0);

    await logs.flush();

    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    expect(call.url).toBe('http://api.test/v1/logs/batch');
    expect(call.headers.get('x-platform-key')).toBe(SK);
    expect(call.headers.get('authorization')).toBeNull();
    const entries = logsOf(call);
    expect(entries.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
    for (const e of entries) expect(LogEntryInput.safeParse(e).success).toBe(true);
    expect(entries[0]).toMatchObject({ message: 'user signed up', request_id: 'req_1', trace_id: 't1', attributes: { plan: 'pro', seats: 3 } });
    expect(entries[2].event_name).toBe('db_error');
  });

  it('redacts sensitive attribute keys and flattens non-scalar values', async () => {
    const { api, logs } = setup();
    logs.info('login', {
      password: 'hunter2', api_key: 'k', Authorization: 'Bearer x', nested: { token: 'abc', ok: 1 },
      err: new Error('bad'), skip: undefined, user: 'alice',
    });
    await logs.flush();
    const [e] = logsOf(api.calls[0]!);
    expect(e.attributes.password).toBe('[REDACTED]');
    expect(e.attributes.api_key).toBe('[REDACTED]');
    expect(e.attributes.Authorization).toBe('[REDACTED]');
    expect(e.attributes.nested).toBe('{"token":"[REDACTED]","ok":1}');
    expect(e.attributes.err).toBe('bad');
    expect(e.attributes.user).toBe('alice');
    expect(e.attributes).not.toHaveProperty('skip');
    expect(api.calls[0]!.body).not.toContain('hunter2');
  });

  it('respects the batch count and byte limits and loses no entries', async () => {
    const { api, logs } = setup();
    for (let i = 0; i < 250; i++) logs.info(`m${i}`);
    await logs.flush();
    expect(Math.max(...api.calls.map((c) => logsOf(c).length))).toBeLessThanOrEqual(LOGS_MAX_PER_BATCH);
    expect(api.calls.reduce((n, c) => n + logsOf(c).length, 0)).toBe(250);

    api.calls.length = 0;
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 90; i++) logs.info('big', { a: big, b: big, c: big });
    await logs.flush();
    expect(api.calls.length).toBeGreaterThan(1);
    for (const c of api.calls) expect(new TextEncoder().encode(c.body!).length).toBeLessThanOrEqual(LOGS_MAX_BATCH_BYTES);
    expect(api.calls.reduce((n, c) => n + logsOf(c).length, 0)).toBe(90);
  });

  it('keeps every entry under the per-entry limit by shedding attributes', async () => {
    const { api, logs } = setup();
    const huge = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'y'.repeat(2048)]));
    logs.info('m'.repeat(5000), huge);
    await logs.flush();
    const [e] = logsOf(api.calls[0]!);
    expect(new TextEncoder().encode(JSON.stringify(e)).length).toBeLessThanOrEqual(LOG_MAX_ENTRY_BYTES);
    expect(LogEntryInput.safeParse(e).success).toBe(true);
  });

  it('auto-flushes a full batch without an explicit flush()', async () => {
    const { api, logs } = setup();
    for (let i = 0; i < LOGS_MAX_PER_BATCH; i++) logs.info('x');
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    await logs.flush();
  });

  it('flushes on an interval when configured', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, logs } = setup(OK, { flushIntervalMs: 1000 });
    logs.info('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(1);
    logs.stop();
  });

  it('never throws on odd input', () => {
    const { logs } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      logs.info('', circular);
      logs.error(undefined as unknown as string);
      logs.debug('x', { big: BigInt(1) as unknown as number });
    }).not.toThrow();
  });
});

describe('server logs retry policy', () => {
  it('retries a retryable failure with an identical body', async () => {
    let n = 0;
    const { api, logs } = setup(() => (n++ < 2 ? apiError('unavailable', 503, true) : OK()));
    logs.info('x');
    await logs.flush();
    expect(api.calls).toHaveLength(3);
    expect(api.calls[2]!.body).toBe(api.calls[0]!.body);
  });

  it('does not retry a non-retryable 4xx, drops the batch and reports it through onError', async () => {
    const errors: PlatformError[] = [];
    const { api, logs } = setup(() => apiError('validation_failed', 400), { onError: (e) => errors.push(e) });
    logs.info('x');
    await logs.flush();
    expect(api.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'validation_failed', requestId: 'req_test', retryable: false });
    await logs.flush();
    expect(api.calls).toHaveLength(1); // dropped, not kept
  });

  it('keeps entries when the API stays unreachable and sends them on the next flush', async () => {
    let down = true;
    const { api, logs } = setup(() => (down ? Promise.reject(new TypeError('offline')) : OK()));
    logs.info('keep me');
    await expect(logs.flush()).resolves.toBeUndefined(); // never rejects
    const attempts = api.calls.length;
    expect(attempts).toBe(4); // 1 + 3 retries
    down = false;
    await logs.flush();
    expect(logsOf(api.calls[attempts]!).map((e) => e.message)).toEqual(['keep me']);
  });

  it('does not retry 401 (bad service key)', async () => {
    const { api, logs } = setup(() => apiError('unauthenticated', 401));
    logs.info('x');
    await logs.flush();
    expect(api.calls).toHaveLength(1);
  });
});
