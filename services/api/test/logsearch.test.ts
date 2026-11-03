// searchLogs: log_index → partitioned R2 archive → exact filter.
import type { LogQueueMessage } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { decodeLogCursor, searchLogs, type LogSearchInput } from '../src/lib/logsearch/index.ts';

const T0 = Date.parse('2026-05-01T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const msg = (product: string, over: Partial<LogQueueMessage['entry']> & { ingest?: string; source?: 'server' | 'browser' } = {}): LogQueueMessage => ({
  product_id: product, environment: 'prod', source: over.source ?? 'server', received_at: iso(T0), ingest_request_id: over.ingest ?? 'req_ingest',
  entry: { level: 'info', timestamp: iso(T0), message: 'm', attributes: {}, ...over },
});

/** Archive one NDJSON object and index it the way the consumer does (request id + ingest id per entry). */
async function archive(key: string, messages: LogQueueMessage[], rawLines: string[] = []) {
  await env.ARCHIVE.put(key, [...messages.map((m) => JSON.stringify(m)), ...rawLines].join('\n') + '\n');
  for (const m of messages) {
    for (const rid of [m.entry.request_id, m.ingest_request_id]) {
      if (!rid) continue;
      await env.INGEST_DB.prepare('INSERT INTO log_index (product_env_id, request_id, occurred_at, level, archive_key) VALUES (?, ?, ?, ?, ?)')
        .bind(`${m.product_id}.${m.environment}`, rid, Date.parse(m.entry.timestamp), m.entry.level, key).run();
    }
  }
}

const window = { from: T0 - 1000, to: T0 + 3600_000 };
const search = async (input: LogSearchInput) => (await searchLogs(env, input)).logs;

/** Follows `next_before` to the end; returns the messages page by page. */
async function allPages(input: LogSearchInput) {
  const pages: string[][] = [];
  let before: string | null = null;
  do {
    const res = await searchLogs(env, { ...input, ...(before ? { before: decodeLogCursor(before)! } : {}) });
    pages.push(res.logs.map((r) => r.entry.message));
    before = res.next_before;
  } while (before && pages.length < 100);
  return pages;
}

describe('searchLogs', () => {
  it('finds a log by its own request_id and by the ingest request id', async () => {
    await archive('logs/ls_a/prod/2026/05/01/10/a1.ndjson', [
      msg('ls_a', { message: 'target', request_id: 'req_target', ingest: 'req_i1' }),
      msg('ls_a', { message: 'sibling', ingest: 'req_i1' }),
      msg('ls_a', { message: 'noise', request_id: 'req_noise', ingest: 'req_i2' }),
    ]);
    const byRequest = await search({ productEnvId: 'ls_a.prod', ...window, requestId: 'req_target' });
    expect(byRequest.map((r) => r.entry.message)).toEqual(['target']);
    const byIngest = await search({ productEnvId: 'ls_a.prod', ...window, requestId: 'req_i1' });
    expect(byIngest.map((r) => r.entry.message).sort()).toEqual(['sibling', 'target']);
  });

  it("never returns another product's logs, even for a request_id that exists there", async () => {
    await archive('logs/ls_b/prod/2026/05/01/10/b1.ndjson', [msg('ls_b', { message: 'b secret', request_id: 'req_shared', ingest: 'req_ib' })]);
    await archive('logs/ls_c/prod/2026/05/01/10/c1.ndjson', [msg('ls_c', { message: 'c entry', request_id: 'req_shared', ingest: 'req_ic' })]);
    const forB = await search({ productEnvId: 'ls_b.prod', ...window, requestId: 'req_shared' });
    expect(forB.map((r) => r.entry.message)).toEqual(['b secret']);
    expect(await search({ productEnvId: 'ls_d.prod', ...window, requestId: 'req_shared' })).toEqual([]);
  });

  it('also filters inside an archive object, so a foreign entry in a mis-indexed object stays hidden', async () => {
    await archive('logs/ls_e/prod/2026/05/01/10/e1.ndjson', [
      msg('ls_e', { message: 'mine', request_id: 'req_mix', ingest: 'req_ie' }),
      msg('ls_f', { message: 'foreign', request_id: 'req_mix', ingest: 'req_ie' }),
    ]);
    const res = await search({ productEnvId: 'ls_e.prod', ...window, requestId: 'req_mix' });
    expect(res.map((r) => r.entry.message)).toEqual(['mine']);
  });

  it('filters by level and time window; without request_id every entry is reachable through its ingest id', async () => {
    await archive('logs/ls_g/prod/2026/05/01/10/g1.ndjson', [
      msg('ls_g', { message: 'early info', timestamp: iso(T0), ingest: 'req_g1' }),
      msg('ls_g', { message: 'err', level: 'error', timestamp: iso(T0 + 60_000), ingest: 'req_g1' }),
      msg('ls_g', { message: 'late err', level: 'error', timestamp: iso(T0 + 2 * 3600_000), ingest: 'req_g2' }),
    ]);
    const errors = await search({ productEnvId: 'ls_g.prod', ...window, level: 'error' });
    expect(errors.map((r) => r.entry.message)).toEqual(['err']);
    const all = await search({ productEnvId: 'ls_g.prod', from: T0 - 1000, to: T0 + 3 * 3600_000 });
    expect(all.map((r) => r.entry.message)).toEqual(['late err', 'err', 'early info']);
    expect((await search({ productEnvId: 'ls_g.prod', from: T0 - 1000, to: T0 + 3 * 3600_000, limit: 2 })).map((r) => r.entry.message)).toEqual(['late err', 'err']);
  });

  it('keeps the source so browser reports are never mistaken for trusted server logs, and skips corrupt lines', async () => {
    await archive('logs/ls_h/prod/2026/05/01/10/h1.ndjson', [msg('ls_h', { message: 'from browser', source: 'browser', request_id: 'req_h', ingest: 'req_ih' })], ['{not json']);
    const res = await search({ productEnvId: 'ls_h.prod', ...window, requestId: 'req_h' });
    expect(res.map((r) => [r.entry.message, r.source])).toEqual([['from browser', 'browser']]);
  });

  it('returns the newest entries first across archive objects and pages older ones with next_before', async () => {
    // Objects overlap in time and their keys do not follow entry time.
    const at = (min: number) => iso(T0 + min * 60_000);
    await archive('logs/ls_p/prod/2026/05/01/10/z1.ndjson', [1, 4, 7].map((n) => msg('ls_p', { message: `m${n}`, timestamp: at(n), ingest: `req_p${n}` })));
    await archive('logs/ls_p/prod/2026/05/01/10/a2.ndjson', [2, 5, 8].map((n) => msg('ls_p', { message: `m${n}`, timestamp: at(n), ingest: `req_p${n}` })));
    await archive('logs/ls_p/prod/2026/05/01/10/m3.ndjson', [3, 6, 9, 9].map((n, i) => msg('ls_p', { message: `m${n}${i === 3 ? 'b' : ''}`, timestamp: at(n), ingest: `req_q${i}` })));
    const input = { productEnvId: 'ls_p.prod', ...window };
    const first = await searchLogs(env, input);
    expect(first.logs.map((r) => r.entry.message)).toEqual(['m9b', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1']);
    expect(first.next_before).toBeNull();
    // Same order in pages of 3 (entries sharing a timestamp are split across pages deterministically).
    expect(await allPages({ ...input, limit: 3 })).toEqual([['m9b', 'm9', 'm8'], ['m7', 'm6', 'm5'], ['m4', 'm3', 'm2'], ['m1']]);
    expect(await allPages({ ...input, limit: 1 })).toEqual(['m9b', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1'].map((m) => [m]));
    // Filters still apply on later pages.
    expect(await allPages({ ...input, limit: 2, from: T0 + 2 * 60_000, to: T0 + 8 * 60_000 })).toEqual([['m7', 'm6'], ['m5', 'm4'], ['m3', 'm2']]);
  });

  it('pages correctly when one search would have to open more than 50 archive objects', async () => {
    // 60 objects, one entry each, two entries per minute; the newest are in the objects read first.
    for (let n = 0; n < 60; n++) {
      await archive(`logs/ls_q/prod/2026/05/01/10/${String(n).padStart(2, '0')}.ndjson`, [msg('ls_q', { message: `q${n}`, timestamp: iso(T0 + Math.floor(n / 2) * 60_000), ingest: `req_q${n}` })]);
    }
    const pages = await allPages({ productEnvId: 'ls_q.prod', ...window, limit: 200 });
    expect(pages.length).toBeGreaterThan(1);
    const expected = Array.from({ length: 60 }, (_, n) => `q${59 - n}`);
    expect(pages.flat()).toEqual(expected);
  });

  it('a cursor never returns entries of another product', async () => {
    await archive('logs/ls_r/prod/2026/05/01/10/r1.ndjson', [msg('ls_r', { message: 'r', ingest: 'req_r' })]);
    const res = await searchLogs(env, { productEnvId: 'ls_s.prod', ...window, before: { at: T0 + 1000, key: 'logs/ls_r/prod/2026/05/01/10/r1.ndjson', line: 5 } });
    expect(res).toEqual({ logs: [], next_before: null });
  });

  it('decodes only well-formed cursors', () => {
    expect(decodeLogCursor('1777629600000:3:logs/a/prod/x:y.ndjson')).toEqual({ at: 1777629600000, line: 3, key: 'logs/a/prod/x:y.ndjson' });
    for (const bad of ['', 'abc', '1:2', '-1:2:k', '1:x:k', '99999999999999999:1:k']) expect(decodeLogCursor(bad)).toBeNull();
  });
});
