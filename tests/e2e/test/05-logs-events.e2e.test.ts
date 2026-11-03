// PRD §15 items 10 and 11: server logs (Server SDK) and browser error reports (Web SDK) of two
// products go through the queue to the consumer and are found by request_id through the admin
// logs endpoint of their own product only; Web SDK events reach the admin analytics summary of
// A only; a duplicated event_id counts once; a forced consumer failure dead-letters the message,
// which is persisted and replayed into the analytics store.
import { randomUUID } from 'node:crypto';
import { createServerClient } from '@z-cloudbase/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1, r2Keys, replayDlq } from '../local-stack/stack.ts';
import {
  admin, api, consoleToken, createProduct, createServiceKey, createWebApp, newUser, ownerToken as ownerConsoleToken, poll, stack, uniqueProductId,
  type ProductEnv,
} from '../src/world.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;
let b: Awaited<ReturnType<typeof createProduct>>;
let adminB: string;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  a = await createProduct(ownerToken, uniqueProductId('la'));
  b = await createProduct(ownerToken, uniqueProductId('lb'));
  const ub = await newUser('logs-admin-b');
  await admin(ownerToken, 'POST', '/team', { user_id: ub.userId, role: 'product_admin', product_id: b.productId });
  adminB = await consoleToken(ub.login);
});

type LogRecord = { source: string; ingest_request_id: string; entry: { message: string; request_id?: string; level: string; attributes: Record<string, unknown> } };
const findLogs = async (token: string, p: ProductEnv, requestId: string) =>
  admin<{ logs: LogRecord[] }>(token, 'GET', `/products/${p.productId}/logs?env=${p.env}&request_id=${encodeURIComponent(requestId)}`);

function server(p: ProductEnv, serviceKey: string) {
  return createServerClient({ endpoint: stack().apiOrigin, issuer: stack().issuer, serviceKey, retryBaseMs: 10 });
}

describe('§15-10 logs and browser errors, isolated per product', () => {
  it('server logs (Server SDK) are redacted, archived and found by request_id in their own product only', async () => {
    const skA = await createServiceKey(ownerToken, a.prod, ['logs:write']);
    const skB = await createServiceKey(ownerToken, b.prod, ['logs:write']);
    const rid = `req_e2e_${randomUUID()}`;
    const sa = server(a.prod, skA);
    sa.logs.info('checkout started', { order: 42, password: 'hunter2', api_key: 'k' }, { request_id: rid });
    sa.logs.error('payment failed', { order: 42 }, { request_id: rid });
    await sa.flush();
    const sb = server(b.prod, skB);
    sb.logs.info('b only', {}, { request_id: `req_e2e_${randomUUID()}` });
    await sb.flush();

    const found = await poll('A logs by request_id', async () => {
      const r = await findLogs(ownerToken, a.prod, rid);
      return r.body.logs.length === 2 ? r.body.logs : null;
    });
    // Newest first (same timestamp: later line of the archive object first).
    expect(found.map((l) => l.entry.message)).toEqual(['payment failed', 'checkout started']);
    expect(found[1]!.source).toBe('server');
    expect(found[1]!.entry.attributes).toEqual({ order: 42, password: '[REDACTED]', api_key: '[REDACTED]' });
    // Same request id, other product: nothing; B's admin cannot even ask A.
    expect((await findLogs(ownerToken, b.prod, rid)).body.logs).toEqual([]);
    expect((await findLogs(adminB, a.prod, rid)).status).toBe(403);
    // Environment filter: A's dev env has none of A's prod logs.
    expect((await findLogs(ownerToken, a.dev, rid)).body.logs).toEqual([]);
    // Level filter.
    const errors = await admin<{ logs: LogRecord[] }>(ownerToken, 'GET', `/products/${a.productId}/logs?env=prod&request_id=${rid}&level=error`);
    expect(errors.body.logs.map((l) => l.entry.message)).toEqual(['payment failed']);
  });

  it('browser error reports (Web SDK) are found by the ingest request id and marked as browser-sourced', async () => {
    const u = await newUser('browser-error');
    const app = createWebApp(u.browser, a.prod);
    await app.sdk.logs.captureError(new Error('boom: Bearer abc.def.ghi'));
    const ingest = u.browser.requestIds.find((r) => r.path === '/v1/logs/batch');
    expect(ingest?.status).toBe(202);
    const rid = ingest!.requestId!;
    const found = await poll('browser error', async () => (await findLogs(ownerToken, a.prod, rid)).body.logs[0]);
    expect(found).toMatchObject({ source: 'browser', ingest_request_id: rid, entry: { level: 'error', message: 'boom: Bearer [REDACTED]' } });
    expect(found.entry.attributes.url).toBe(`${a.appOrigin}/`);
    expect((await findLogs(adminB, a.prod, rid)).status).toBe(403);
  });
});

type Summary = { events_total: number; top_events: Array<{ name: string; count: number }>; source: string };
const summary = async (p: ProductEnv, token = ownerToken) =>
  (await admin<Summary>(token, 'GET', `/products/${p.productId}/analytics?env=${p.env}`)).body;
const countOf = (s: Summary, name: string) => s.top_events.find((e) => e.name === name)?.count ?? 0;

describe('§15-10 / §15-11 events: queue → consumer → analytics, isolation and dedupe', () => {
  it('Web SDK events of A show up in A\'s analytics summary only', async () => {
    const u = await newUser('events');
    const app = createWebApp(u.browser, a.prod);
    await app.signIn();
    app.sdk.analytics.identify();
    app.sdk.analytics.track('level_start', { level: 1 });
    app.sdk.analytics.track('level_start', { level: 2 });
    app.sdk.analytics.track('purchase', { sku: 'gem_pack', price: 4.99 });
    await app.sdk.analytics.flush();
    const batch = u.browser.requestIds.find((r) => r.path === '/v1/events/batch');
    expect(batch?.status).toBe(202);

    const s = await poll('A analytics', async () => {
      const x = await summary(a.prod);
      return countOf(x, 'level_start') === 2 && countOf(x, 'purchase') === 1 ? x : null;
    });
    expect(s.source).toBe('d1_substitute'); // local stand-in for Analytics Engine (remote unverified)
    const sb = await summary(b.prod);
    expect(sb.events_total).toBe(0);
    expect((await admin(adminB, 'GET', `/products/${a.productId}/analytics?env=prod`)).status).toBe(403);
    // Raw user ids never reach the analytics store, only the per-product HMAC user_key.
    const rows = await d1<{ user_key: string | null }>(stack(), 'ingest', 'SELECT user_key FROM event_rows WHERE product_env_id = ?', [a.prod.clientId]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.user_key && !r.user_key.includes(u.userId))).toBe(true);
  });

  it('a duplicated event_id is accepted once and counted once', async () => {
    const event = { event_id: randomUUID(), event_name: 'dup_check', occurred_at: new Date().toISOString(), properties: {} };
    const send = () => api('/v1/events/batch', { key: a.prod.publishableKey, body: { events: [event] } });
    const first = (await (await send()).json()) as { accepted: number; duplicate: number };
    const second = (await (await send()).json()) as { accepted: number; duplicate: number };
    expect(first).toMatchObject({ accepted: 1, duplicate: 0 });
    expect(second).toMatchObject({ accepted: 0, duplicate: 1 });
    // Same id in another product is a different event.
    const other = (await (await api('/v1/events/batch', { key: b.prod.publishableKey, body: { events: [event] } })).json()) as { accepted: number };
    expect(other.accepted).toBe(1);
    await poll('dup_check counted', async () => countOf(await summary(a.prod), 'dup_check') === 1);
    await new Promise((r) => setTimeout(r, 6000)); // longer than one consumer batch window
    expect(countOf(await summary(a.prod), 'dup_check')).toBe(1);
    expect(countOf(await summary(b.prod), 'dup_check')).toBe(1);
  });

  it('unregistered event names are accepted with a warning outside prod', async () => {
    const res = await api('/v1/events/batch', {
      key: a.dev.publishableKey, body: { events: [{ event_id: randomUUID(), event_name: 'never_registered', occurred_at: new Date().toISOString() }] },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: 1, warnings: [{ index: 0, code: 'unknown_event' }] });
  });
});

describe('§15-11 queue failure and DLQ recovery drill', () => {
  it('a message the consumer cannot store is retried, dead-lettered, persisted in the archive and replayed after the fault is fixed', async () => {
    const p = await createProduct(ownerToken, uniqueProductId('dq'));
    // Fault injection: the analytics store rejects this event (a stand-in for a storage outage).
    await d1(stack(), 'ingest', `CREATE TRIGGER IF NOT EXISTS e2e_dlq_fault BEFORE INSERT ON event_rows
      WHEN NEW.event_name = 'dlq_drill' BEGIN SELECT RAISE(ABORT, 'e2e forced failure'); END`);
    try {
      const eventId = randomUUID();
      const res = await api('/v1/events/batch', {
        key: p.prod.publishableKey, body: { events: [{ event_id: eventId, event_name: 'dlq_drill', occurred_at: new Date().toISOString() }] },
      });
      expect(((await res.json()) as { accepted: number }).accepted).toBe(1);

      const day = new Date().toISOString().slice(0, 10);
      const dead = await poll('dead letter in the archive', async () => {
        const keys = await r2Keys(stack(), 'z-cloudbase-archive', `dlq/z-cloudbase-events-dlq/${day}/`);
        return keys.length ? keys : null;
      }, 90_000, 1000);
      expect(dead.length).toBeGreaterThanOrEqual(1);
      expect(countOf(await summary(p.prod), 'dlq_drill')).toBe(0);
    } finally {
      await d1(stack(), 'ingest', 'DROP TRIGGER IF EXISTS e2e_dlq_fault');
    }

    expect(await replayDlq(stack(), 'z-cloudbase-events-dlq')).toBeGreaterThanOrEqual(1);
    await poll('replayed event counted', async () => countOf(await summary(p.prod), 'dlq_drill') === 1, 60_000, 1000);
    expect(await r2Keys(stack(), 'z-cloudbase-archive', 'dlq/z-cloudbase-events-dlq/')).toEqual([]);
  });
});
