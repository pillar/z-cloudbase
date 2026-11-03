// v3.1 analytics store (PRD §21.7–21.9): packed queue messages → event_rows, actor tables, AE, gzip archive;
// retention pruning, archive expiry and per-user erasure with archive suppression.
import { newId, newUserId } from '@z-cloudbase/contracts';
import { userKey } from '@z-cloudbase/security';
import { createExecutionContext, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { eraseUserAnalytics } from '../src/analytics-erasure.ts';
import { expireArchive, pruneAnalytics } from '../src/analytics-retention.ts';
import { processDueRequests } from '../src/deletion.ts';
import { archiveDayPrefix, gzipText, pathDimension } from '../src/events.ts';
import { deliver, eventsMessage, fakeAe, fixedBatch, legacyEventMessage, seedMembership, seedProduct } from './helpers.ts';

const DAY = 24 * 3600 * 1000;
const D = '2026-07-01';
const at = (hhmm: string, day = D) => `${day}T${hhmm}:00Z`;
const dayNo = (iso: string) => Math.floor(Date.parse(iso) / DAY);
const q = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => (await baseEnv.INGEST_DB.prepare(sql).bind(...args).all<T>()).results;
const listKeys = async (prefix: string) => (await baseEnv.ARCHIVE.list({ prefix })).objects.map((o) => o.key);

describe('events consumer → analytics store', () => {
  it('stores a packed message: event rows with context and dimensions, per-actor days, actors, AE points', async () => {
    const ae = fakeAe();
    const big = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, 'x'.repeat(200)])); // > 1 KB of properties
    const m = eventsMessage('as_a', 'prod', [
      { event_name: 'page_view', user_key: 'uk1', occurred_at: at('10:00'), properties: { path: '/pricing?ref=mail#top', plan: 'pro' } },
      { event_name: 'page_view', user_key: 'uk1', occurred_at: at('09:00'), properties: { path: '/home', plan: 'free' } },
      { event_name: 'page_view', user_key: 'uk1', occurred_at: at('11:00'), properties: { path: '/x' } },
      { event_name: 'signup', anonymous_id: 'dev-9', occurred_at: at('12:00'), properties: big },
      { event_name: 'cron_job', occurred_at: at('13:00') }, // no actor: event row and AE only
    ], { dimensions: ['plan'] });
    const r = await deliver('z-cloudbase-events', [m], { ...baseEnv, EVENTS_AE: ae });
    expect(r.acked).toHaveLength(1);
    expect(ae.points).toHaveLength(5);
    expect(ae.points[0]!.blobs.slice(5)).toEqual(['/pricing', 'chrome', 'macos', 'desktop', 'DE', 'client', 'pro', '', '']);

    const rows = await q<any>('SELECT event_name, path, dim1, dim_keys, properties, properties_truncated FROM event_rows WHERE product_env_id = ? ORDER BY occurred_at', 'as_a.prod');
    expect(rows.map((x) => [x.event_name, x.path, x.dim1])).toEqual([
      ['page_view', '/home', 'free'], ['page_view', '/pricing', 'pro'], ['page_view', '/x', ''], ['signup', '', ''], ['cron_job', '', ''],
    ]);
    expect(rows[0].dim_keys).toBe('["plan"]');
    expect(rows[3]).toMatchObject({ properties: null, properties_truncated: 1 });

    const daily = await q<any>('SELECT event_name, actor, day, first_at, last_at, n, dims FROM actor_daily WHERE product_env_id = ? ORDER BY event_name, actor', 'as_a.prod');
    expect(daily).toHaveLength(2);
    expect(daily[0]).toMatchObject({ event_name: 'page_view', actor: 'uk1', day: dayNo(at('00:00')), first_at: Date.parse(at('09:00')), last_at: Date.parse(at('11:00')), n: 3 });
    expect(JSON.parse(daily[0].dims)).toMatchObject({ path: '/home', 'prop:plan': 'free', country: 'DE' }); // dims of the day's first occurrence
    expect(daily[1]).toMatchObject({ event_name: 'signup', actor: 'anon:dev-9', n: 1 });
    expect(await q('SELECT actor, first_day, last_day FROM actors WHERE product_env_id = ? ORDER BY actor', 'as_a.prod')).toEqual([
      { actor: 'anon:dev-9', first_day: dayNo(at('00:00')), last_day: dayNo(at('00:00')) },
      { actor: 'uk1', first_day: dayNo(at('00:00')), last_day: dayNo(at('00:00')) },
    ]);
  });

  it('merges later batches into the same actor day and extends actors.last_day', async () => {
    await deliver('z-cloudbase-events', [eventsMessage('as_b', 'prod', [{ event_name: 'open', user_key: 'u', occurred_at: at('12:00') }])], { ...baseEnv, EVENTS_AE: fakeAe() });
    await deliver('z-cloudbase-events', [eventsMessage('as_b', 'prod', [
      { event_name: 'open', user_key: 'u', occurred_at: at('08:00') },
      { event_name: 'open', user_key: 'u', occurred_at: at('08:00', '2026-07-03') },
    ])], { ...baseEnv, EVENTS_AE: fakeAe() });
    expect(await q('SELECT day, first_at, last_at, n FROM actor_daily WHERE product_env_id = ? ORDER BY day', 'as_b.prod')).toEqual([
      { day: dayNo(at('00:00')), first_at: Date.parse(at('08:00')), last_at: Date.parse(at('12:00')), n: 2 },
      { day: dayNo(at('00:00', '2026-07-03')), first_at: Date.parse(at('08:00', '2026-07-03')), last_at: Date.parse(at('08:00', '2026-07-03')), n: 1 },
    ]);
    expect(await q('SELECT first_day, last_day FROM actors WHERE product_env_id = ?', 'as_b.prod')).toEqual([{ first_day: dayNo(at('00:00')), last_day: dayNo(at('00:00', '2026-07-03')) }]);
    // Archive partitions are per occurrence day, date first.
    expect(await listKeys('events/v2/2026/07/03/as_b/prod/')).toHaveLength(1);
  });

  it('is idempotent on redelivery: no second AE point, no double count in actor rows', async () => {
    const ae = fakeAe();
    const items = [{ id: 'as-redeliver-1', body: eventsMessage('as_c', 'prod', [{ event_name: 'buy', user_key: 'u', occurred_at: at('10:00') }, { event_name: 'buy', user_key: 'u', occurred_at: at('10:05') }]) }];
    for (let i = 0; i < 2; i++) {
      const batch = fixedBatch('z-cloudbase-events', items);
      const ctx = createExecutionContext();
      await worker.queue(batch, { ...baseEnv, EVENTS_AE: ae } as typeof baseEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['as-redeliver-1']);
    }
    expect(ae.points).toHaveLength(2);
    expect(await q('SELECT n FROM actor_daily WHERE product_env_id = ?', 'as_c.prod')).toEqual([{ n: 2 }]);
    expect(await listKeys('events/v2/2026/07/01/as_c/prod/')).toHaveLength(1);
  });

  it('accepts v3.0 single-event messages queued before an upgrade', async () => {
    const r = await deliver('z-cloudbase-events', [legacyEventMessage('as_d', 'prod', { user_key: 'old', occurred_at: at('10:00') })], { ...baseEnv, EVENTS_AE: fakeAe() });
    expect(r.acked).toHaveLength(1);
    expect(await q('SELECT user_key, source FROM event_rows WHERE product_env_id = ?', 'as_d.prod')).toEqual([{ user_key: 'old', source: 'client' }]);
  });

  it('retries messages that carry a raw user_id or have no events, and writes nothing for them', async () => {
    const bad = eventsMessage('as_e', 'prod', [{ event_name: 'x' }]);
    (bad.events[0]!.event as Record<string, unknown>).user_id = 'usr_leak';
    const r = await deliver('z-cloudbase-events', [bad, { ...eventsMessage('as_e', 'prod', []), events: [] }], { ...baseEnv, EVENTS_AE: fakeAe() });
    expect(r.retried).toHaveLength(2);
    expect(await q('SELECT 1 FROM event_rows WHERE product_env_id = ?', 'as_e.prod')).toEqual([]);
  });

  it('derives the path dimension without query strings or non-route fragments', () => {
    expect(pathDimension('/a/b?token=x#frag')).toBe('/a/b');
    expect(pathDimension('/app#/settings?tab=1')).toBe('/app#/settings');
    expect(pathDimension(42)).toBe('');
  });
});

describe('retention and archive expiry', () => {
  it('prunes event rows, actor days, actors and old suppressions outside the windows', async () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const today = Math.floor(now / DAY);
    await baseEnv.INGEST_DB.batch([
      baseEnv.INGEST_DB.prepare(`INSERT INTO actor_daily (product_env_id, event_name, day, actor, first_at, last_at, n) VALUES ('pr_a.prod', 'e', ?, 'old', 0, 0, 1), ('pr_a.prod', 'e', ?, 'new', 0, 0, 1)`).bind(today - 91, today - 5),
      baseEnv.INGEST_DB.prepare(`INSERT INTO actors (product_env_id, actor, first_day, last_day) VALUES ('pr_a.prod', 'old', ?, ?), ('pr_a.prod', 'new', ?, ?)`).bind(today - 95, today - 91, today - 95, today - 5),
      baseEnv.INGEST_DB.prepare(`INSERT INTO archive_suppressions (product_env_id, user_key, created_at) VALUES ('pr_a.prod', 'gone', ?), ('pr_a.prod', 'recent', ?)`).bind(now - 91 * DAY, now - DAY),
    ]);
    await pruneAnalytics(baseEnv, now);
    expect((await q<{ actor: string }>(`SELECT actor FROM actor_daily WHERE product_env_id = 'pr_a.prod'`)).map((r) => r.actor)).toEqual(['new']);
    expect((await q<{ actor: string }>(`SELECT actor FROM actors WHERE product_env_id = 'pr_a.prod'`)).map((r) => r.actor)).toEqual(['new']);
    expect((await q<{ user_key: string }>(`SELECT user_key FROM archive_suppressions WHERE product_env_id = 'pr_a.prod'`)).map((r) => r.user_key)).toEqual(['recent']);
    // Shorter retention configured by the operator.
    await pruneAnalytics({ ...baseEnv, ANALYTICS_RETENTION_DAYS: '3' } as unknown as typeof baseEnv, now);
    expect(await q(`SELECT actor FROM actor_daily WHERE product_env_id = 'pr_a.prod'`)).toEqual([]);
  });

  it('deletes whole expired date partitions of the archive and keeps recent ones', async () => {
    const now = Date.parse('2027-03-01T03:00:00Z');
    const today = Math.floor(now / DAY);
    const expired = archiveDayPrefix(today - 92, 'ex_a', 'prod');
    const kept = archiveDayPrefix(today - 10, 'ex_a', 'prod');
    await baseEnv.ARCHIVE.put(`${expired}a.ndjson.gz`, await gzipText('{}\n'));
    await baseEnv.ARCHIVE.put(`${archiveDayPrefix(today - 92, 'ex_b', 'dev')}b.ndjson.gz`, await gzipText('{}\n'));
    await baseEnv.ARCHIVE.put(`${kept}c.ndjson.gz`, await gzipText('{}\n'));
    expect(await expireArchive(baseEnv, now)).toBe(2);
    expect(await listKeys(archiveDayPrefix(today - 92))).toEqual([]);
    expect(await listKeys(kept)).toHaveLength(1);
  });
});

describe('erasure of a deleted user (PRD §21.9)', () => {
  beforeAll(async () => {
    for (const p of ['er_a', 'er_b']) await seedProduct(baseEnv.DB, p, 'prod');
  });

  async function seedUserData(productEnvId: string, key: string) {
    const t = Date.parse(at('10:00'));
    await deliver('z-cloudbase-events', [eventsMessage(productEnvId.split('.')[0]!, 'prod', [
      { event_name: 'open', user_key: key, occurred_at: at('10:00') },
      { event_name: 'buy', user_key: key, occurred_at: at('11:00', '2026-07-02') },
    ])], { ...baseEnv, EVENTS_AE: fakeAe() });
    await baseEnv.INGEST_DB.prepare(`INSERT OR REPLACE INTO user_properties (product_env_id, user_key, properties, updated_at) VALUES (?, ?, '{"plan":"pro"}', ?)`).bind(productEnvId, key, t).run();
  }
  const countFor = async (productEnvId: string, key: string) => {
    const [e, d, a, u] = await Promise.all([
      q('SELECT 1 FROM event_rows WHERE product_env_id = ? AND user_key = ?', productEnvId, key),
      q('SELECT 1 FROM actor_daily WHERE product_env_id = ? AND actor = ?', productEnvId, key),
      q('SELECT 1 FROM actors WHERE product_env_id = ? AND actor = ?', productEnvId, key),
      q('SELECT 1 FROM user_properties WHERE product_env_id = ? AND user_key = ?', productEnvId, key),
    ]);
    return [e.length, d.length, a.length, u.length];
  };

  it('product scope: erases that product only, other users untouched, and suppresses the archive', async () => {
    const user = newUserId();
    const other = newUserId();
    const k = await userKey(user, 'salt'); // consumer test products all use the salt 'salt'
    const ko = await userKey(other, 'salt');
    await seedUserData('er_a.prod', k);
    await seedUserData('er_a.prod', ko);
    await seedUserData('er_b.prod', k);
    expect(await countFor('er_a.prod', k)).toEqual([2, 2, 1, 1]);

    expect(await eraseUserAnalytics(baseEnv, user, 'er_a')).toEqual(['er_a.prod']);
    expect(await countFor('er_a.prod', k)).toEqual([0, 0, 0, 0]);
    expect(await countFor('er_a.prod', ko)).toEqual([2, 2, 1, 1]);
    expect(await countFor('er_b.prod', k)).toEqual([2, 2, 1, 1]);
    expect(await q('SELECT product_env_id FROM archive_suppressions WHERE user_key = ?', k)).toEqual([{ product_env_id: 'er_a.prod' }]);
    // Idempotent re-run (a crashed deletion is processed again).
    expect(await eraseUserAnalytics(baseEnv, user, 'er_a')).toEqual([]);
    expect(await q('SELECT product_env_id FROM archive_suppressions WHERE user_key = ?', k)).toEqual([{ product_env_id: 'er_a.prod' }]);
  });

  it('suppresses every environment of the scope when the archive outlives the analytics window', async () => {
    const user = newUserId();
    const k = await userKey(user, 'salt');
    await eraseUserAnalytics({ ...baseEnv, ARCHIVE_RETENTION_DAYS: '365' } as unknown as typeof baseEnv, user, 'er_b');
    expect((await q<{ product_env_id: string }>('SELECT product_env_id FROM archive_suppressions WHERE user_key = ?', k)).map((r) => r.product_env_id)).toEqual(['er_b.prod']);
  });

  it('account deletion through the pipeline erases the user in every product', async () => {
    const user = newUserId();
    const k = await userKey(user, 'salt');
    await seedMembership(baseEnv.DB, user, 'er_a');
    await seedUserData('er_a.prod', k);
    await seedUserData('er_b.prod', k);
    const id = newId('del');
    await baseEnv.DB.prepare(
      `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, 'delete', 'account', NULL, 'pending', ?, ?)`,
    ).bind(id, user, Date.now() - 1000, Date.now() - 1000).run();
    const identity = { revokeUserTokens: vi.fn(async () => {}), deleteUserIdentity: vi.fn(async () => {}), exportUserIdentity: vi.fn() };
    expect(await processDueRequests({ ...baseEnv, IDENTITY: identity } as unknown as typeof baseEnv)).toMatchObject({ completed: 1 });
    expect(await countFor('er_a.prod', k)).toEqual([0, 0, 0, 0]);
    expect(await countFor('er_b.prod', k)).toEqual([0, 0, 0, 0]);
    expect((await q<{ product_env_id: string }>('SELECT product_env_id FROM archive_suppressions WHERE user_key = ? ORDER BY product_env_id', k)).map((r) => r.product_env_id))
      .toEqual(['er_a.prod', 'er_b.prod']);
  });
});
