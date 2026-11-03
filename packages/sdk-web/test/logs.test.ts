import { BROWSER_ERROR_MAX_BYTES, BrowserErrorInput } from '@z-cloudbase/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.ts';
import { createLogs } from '../src/logs.ts';
import { PK, baseConfig, fakeFetch, json } from './helpers.ts';

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'http://app.test', pathname: '/settings', href: 'http://app.test/settings?token=secret#frag' });
});
afterEach(() => vi.unstubAllGlobals());

const setup = (handler: Parameters<typeof fakeFetch>[0] = () => json({ accepted: 1 })) => {
  const api = fakeFetch(handler);
  return { api, logs: createLogs(baseConfig({ fetch: api.fetch })) };
};

describe('logs.captureError', () => {
  it('posts a valid browser error report with the publishable key and no user token', async () => {
    const { api, logs } = setup();
    await logs.captureError(new TypeError('x is undefined'));
    const call = api.calls[0]!;
    expect(call.url).toBe('http://api.test/v1/logs/batch');
    expect(call.headers.get('x-platform-key')).toBe(PK);
    expect(call.headers.get('authorization')).toBeNull();
    const [report] = call.json().logs;
    expect(BrowserErrorInput.safeParse(report).success).toBe(true);
    expect(report.message).toBe('x is undefined');
    expect(report.stack).toContain('TypeError');
    expect(report.url).toBe('http://app.test/settings'); // no query or fragment
  });

  it('accepts non-Error values', async () => {
    const { api, logs } = setup();
    await logs.captureError('plain string failure');
    expect(api.calls[0]!.json().logs[0].message).toBe('plain string failure');
  });

  it('truncates oversized reports to the ingest limit', async () => {
    const { api, logs } = setup();
    const e = new Error('m'.repeat(10_000));
    e.stack = 's'.repeat(50_000);
    await logs.captureError(e);
    const [report] = api.calls[0]!.json().logs;
    expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(BROWSER_ERROR_MAX_BYTES);
    expect(BrowserErrorInput.safeParse(report).success).toBe(true);
  });

  it('masks bearer tokens, JWTs and API keys in messages and stacks', async () => {
    const { api, logs } = setup();
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3JfMSJ9.c2lnbmF0dXJl';
    const e = new Error(`failed with Authorization: Bearer ${jwt} using ${PK}`);
    e.stack = `Error: ${jwt}`;
    await logs.captureError(e);
    const body = api.calls[0]!.body!;
    expect(body).not.toContain(jwt);
    expect(body).not.toContain(PK);
    expect(body).toContain('[REDACTED]');
  });

  it('never throws, even when the network is down or the API rejects', async () => {
    const down = createLogs(baseConfig({ fetch: (() => Promise.reject(new TypeError('offline'))) as typeof fetch }));
    await expect(down.captureError(new Error('x'))).resolves.toBeUndefined();
    const rejected = setup(() => json({ error: { code: 'rate_limited', message: 'x', request_id: 'r', retryable: true } }, 429));
    await expect(rejected.logs.captureError(new Error('x'))).resolves.toBeUndefined();
    expect(rejected.api.calls).toHaveLength(1); // a failing error reporter must not amplify load
  });
});

describe('createClient', () => {
  it('exposes auth, storage, analytics and logs and validates the config up front', () => {
    const client = createClient({ ...baseConfig(), analytics: { flushIntervalMs: 0 } });
    expect(Object.keys(client).sort()).toEqual(['analytics', 'auth', 'dispose', 'logs', 'storage']);
    expect(() => createClient(baseConfig({ publishableKey: 'pk_prod_' + 'a'.repeat(33) }))).toThrow(/different env/);
  });
});
