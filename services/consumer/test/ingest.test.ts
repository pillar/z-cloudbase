// Logs / events queue consumers (PRD §9) plus the read side (api lib) over what they wrote.
import { env as baseEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { analyticsQuery } from '../../api/src/lib/analytics/index.ts';
import { searchLogs } from '../../api/src/lib/logsearch/index.ts';
import { deliver, eventMessage, fakeAe, fixedBatch, logMessage } from './helpers.ts';
import { createExecutionContext, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.ts';

const DAY = '2026-06-02';
const at = (hh: string) => `${DAY}T${hh}:00Z`;
const day = { from: DAY, to: '2026-06-03' };
const listKeys = async (prefix: string) => (await baseEnv.ARCHIVE.list({ prefix })).objects.map((o) => o.key);
const ndjson = async (key: string) => (await (await baseEnv.ARCHIVE.get(key))!.text()).trim().split('\n').map((l) => JSON.parse(l));
const indexRows = async (productEnvId: string) =>
  (await baseEnv.INGEST_DB.prepare('SELECT request_id, level, archive_key FROM log_index WHERE product_env_id = ? ORDER BY request_id').bind(productEnvId).all<{ request_id: string; level: string; archive_key: string }>()).results;

describe('logs consumer', () => {
  it('archives NDJSON under the product/env/date/hour partition, indexes request ids, and acks', async () => {
    const m = logMessage('lc_a', 'prod', { message: 'checkout failed', level: 'error', request_id: 'req_user', ingest: 'req_ing', received: at('07:30'), timestamp: at('07:29') });
    const r = await deliver('z-cloudbase-logs', [m]);
    expect(r.acked).toHaveLength(1);
    expect(r.retried).toEqual([]);

    const keys = await listKeys('logs/lc_a/prod/2026/06/02/07/');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/\/[0-9a-f]{32}\.ndjson$/);
    expect(await ndjson(keys[0]!)).toEqual([m]);
    expect((await indexRows('lc_a.prod')).map((x) => [x.request_id, x.level, x.archive_key])).toEqual([
      ['req_ing', 'error', keys[0]], ['req_user', 'error', keys[0]],
    ]);
  });

  it('makes a log findable by request_id for its own product only', async () => {
    const t = at('08:10');
    await deliver('z-cloudbase-logs', [
      logMessage('lc_b', 'prod', { message: 'b log', request_id: 'req_shared', received: t, timestamp: t }),
      logMessage('lc_c', 'prod', { message: 'c log', request_id: 'req_shared', received: t, timestamp: t }),
    ]);
    const window = { from: Date.parse(at('00:00')), to: Date.parse(at('23:00')) };
    const b = await searchLogs(baseEnv, { productEnvId: 'lc_b.prod', ...window, requestId: 'req_shared' });
    expect(b.map((r) => r.entry.message)).toEqual(['b log']);
    const c = await searchLogs(baseEnv, { productEnvId: 'lc_c.prod', ...window, requestId: 'req_shared' });
    expect(c.map((r) => r.entry.message)).toEqual(['c log']);
    expect(await searchLogs(baseEnv, { productEnvId: 'lc_other.prod', ...window, requestId: 'req_shared' })).toEqual([]);
    // Partitions are physically separate objects.
    expect(await listKeys('logs/lc_b/prod/')).toHaveLength(1);
    expect(await listKeys('logs/lc_c/prod/')).toHaveLength(1);
  });

  it('retries only the messages of a group whose write failed, and acks the rest', async () => {
    const flaky = {
      ...baseEnv,
      ARCHIVE: new Proxy(baseEnv.ARCHIVE, {
        get: (t, p) => (p === 'put' ? async (key: string, ...rest: unknown[]) => { if (key.includes('/lc_bad/')) throw new Error('r2 down'); return (t.put as Function)(key, ...rest); } : (t as any)[p]?.bind(t)),
      }),
    };
    const r = await deliver('z-cloudbase-logs', [logMessage('lc_good', 'prod'), logMessage('lc_bad', 'prod'), logMessage('lc_good', 'prod')], flaky as any);
    expect(r.acked).toHaveLength(2);
    expect(r.retried).toHaveLength(1);
    expect(await indexRows('lc_bad.prod')).toEqual([]);
  });

  it('retries malformed messages (they end up in the DLQ) without blocking valid ones', async () => {
    const r = await deliver('z-cloudbase-logs', [{ junk: true }, logMessage('lc_mal', 'prod'), logMessage('Bad Product', 'prod'), logMessage('lc_mal', 'qa')]);
    expect(r.acked).toHaveLength(1);
    expect(r.retried).toHaveLength(3);
  });

  it('is idempotent on redelivery: the same messages produce one object and one set of index rows', async () => {
    const items = [{ id: 'redeliver-1', body: logMessage('lc_re', 'prod', { request_id: 'req_re', ingest: 'req_re_i', received: at('09:00') }) }];
    for (let i = 0; i < 2; i++) {
      const batch = fixedBatch('z-cloudbase-logs', items);
      const ctx = createExecutionContext();
      await worker.queue(batch, baseEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['redeliver-1']);
    }
    expect(await listKeys('logs/lc_re/prod/')).toHaveLength(1);
    expect(await indexRows('lc_re.prod')).toHaveLength(2);
  });
});

describe('events consumer', () => {
  it('writes the Analytics Engine data point, the substitute row and the raw archive, then acks', async () => {
    const ae = fakeAe();
    const m = eventMessage('ec_a', 'prod', { event_name: 'signup', anonymous_id: 'dev-1', user_key: 'uk_1', occurred_at: at('10:00'), received: at('10:01') });
    const r = await deliver('z-cloudbase-events', [m], { ...baseEnv, EVENTS_AE: ae });
    expect(r.acked).toHaveLength(1);
    expect(ae.points).toEqual([{ indexes: ['ec_a.prod'], blobs: ['ec_a', 'prod', 'signup', 'uk_1', 'dev-1'], doubles: [1] }]);
    const keys = await listKeys('events/ec_a/prod/2026/06/02/');
    expect(keys).toHaveLength(1);
    expect(await ndjson(keys[0]!)).toEqual([m]);
    const row = await baseEnv.INGEST_DB.prepare('SELECT * FROM events_substitute WHERE product_env_id = ?').bind('ec_a.prod').first();
    expect(row).toMatchObject({ event_id: m.event.event_id, event_name: 'signup', user_key: 'uk_1', anonymous_id: 'dev-1', occurred_at: Date.parse(at('10:00')) });
  });

  it('shows an event in the summary of its own product and not of another', async () => {
    await deliver('z-cloudbase-events', [
      eventMessage('ec_b', 'prod', { event_name: 'only_b', user_key: 'ub', occurred_at: at('11:00') }),
      eventMessage('ec_c', 'prod', { event_name: 'only_c', anonymous_id: 'dc', occurred_at: at('11:00') }),
    ], { ...baseEnv, EVENTS_AE: fakeAe() });
    const q = analyticsQuery(baseEnv);
    const b = await q.summary({ productEnvId: 'ec_b.prod', ...day });
    expect(b.top_events).toEqual([{ name: 'only_b', count: 1 }]);
    expect(b.daily).toEqual([{ day: DAY, users: 1, anonymous: 0, events: 1 }]);
    const c = await q.summary({ productEnvId: 'ec_c.prod', ...day });
    expect(c.top_events).toEqual([{ name: 'only_c', count: 1 }]);
    expect(c.daily).toEqual([{ day: DAY, users: 0, anonymous: 1, events: 1 }]);
    expect(JSON.stringify(b)).not.toContain('only_c');
    expect((await q.summary({ productEnvId: 'ec_none.prod', ...day })).events_total).toBe(0);
  });

  it('counts a duplicate event_id once, even when it is delivered in separate batches', async () => {
    const ae = fakeAe();
    const m = eventMessage('ec_d', 'prod', { occurred_at: at('12:00') });
    await deliver('z-cloudbase-events', [m], { ...baseEnv, EVENTS_AE: ae });
    await deliver('z-cloudbase-events', [m, m], { ...baseEnv, EVENTS_AE: ae });
    expect(ae.points).toHaveLength(1);
    expect((await analyticsQuery(baseEnv).summary({ productEnvId: 'ec_d.prod', ...day })).events_total).toBe(1);
  });

  it('retries a failed group without writing data points, and succeeds on redelivery', async () => {
    const ae = fakeAe();
    const items = [{ id: 'ev-retry-1', body: eventMessage('ec_e', 'prod', { occurred_at: at('13:00') }) }];
    let fail = true;
    const flaky = {
      ...baseEnv,
      EVENTS_AE: ae,
      ARCHIVE: new Proxy(baseEnv.ARCHIVE, {
        get: (t, p) => (p === 'put' ? async (...a: unknown[]) => { if (fail) throw new Error('r2 down'); return (t.put as Function)(...a); } : (t as any)[p]?.bind(t)),
      }),
    };
    const run = async () => {
      const batch = fixedBatch('z-cloudbase-events', items);
      const ctx = createExecutionContext();
      await worker.queue(batch, flaky as any, ctx);
      await waitOnExecutionContext(ctx);
      return getQueueResult(batch, ctx);
    };
    const first = await run();
    expect(first.retryMessages.map((m) => m.msgId)).toEqual(['ev-retry-1']);
    expect(first.explicitAcks).toEqual([]);
    expect(ae.points).toHaveLength(0);
    fail = false;
    expect((await run()).explicitAcks).toEqual(['ev-retry-1']);
    expect(ae.points).toHaveLength(1);
  });

  it('retries malformed messages and never writes them', async () => {
    const ae = fakeAe();
    const r = await deliver('z-cloudbase-events', [{ product_id: 'ec_f', environment: 'prod', event: { event_name: 'x' } }], { ...baseEnv, EVENTS_AE: ae });
    expect(r.retried).toHaveLength(1);
    expect(ae.points).toHaveLength(0);
  });
});

describe('queue routing', () => {
  it('retries messages from an unexpected queue instead of acking (no silent loss)', async () => {
    const r = await deliver('some-other-queue', [{ a: 1 }]);
    expect(r.acked).toEqual([]);
    expect(r.retryAll).toBe(true);
  });
});
