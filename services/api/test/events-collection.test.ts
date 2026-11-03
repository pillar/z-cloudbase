// v3.1 collection (PRD §21.7): packed queue messages with server-derived context, service-key user attribution,
// user properties. Every case also checks that another product's credentials cannot reach this product's data.
import { EVENTS_PER_QUEUE_MESSAGE, newUserId, uuidv7 } from '@z-cloudbase/contracts';
import { userKey } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseUserAgent } from '../src/lib/events/context.ts';
import { errorCode, fakeQueue, post } from './ingest-helpers.ts';
import { seedMembership, seedProduct, seedServiceKey, userFor, type SeededEnv } from './helpers.ts';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ev = (over: Record<string, unknown> = {}) => ({ event_id: uuidv7(), event_name: 'page_view', occurred_at: new Date().toISOString(), properties: {}, ...over });
const json = async (res: Response) => (await res.json()) as any;

let a: SeededEnv;
let b: SeededEnv;
beforeAll(async () => {
  a = await seedProduct({ productId: 'col_a' });
  b = await seedProduct({ productId: 'col_b' });
});

describe('server-derived context', () => {
  it('parses coarse browser / OS / device classes without versions', () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual({ browser: 'chrome', os: 'macos', device: 'desktop' });
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'))
      .toEqual({ browser: 'safari', os: 'ios', device: 'mobile' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Safari/537.36'))
      .toEqual({ browser: 'samsung', os: 'android', device: 'tablet' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'))
      .toEqual({ browser: 'edge', os: 'windows', device: 'desktop' });
    expect(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toEqual({ browser: 'firefox', os: 'linux', device: 'desktop' });
    expect(parseUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)')).toEqual({ browser: 'bot', os: 'other', device: 'bot' });
    expect(parseUserAgent(null)).toEqual({ browser: 'other', os: 'other', device: 'desktop' });
  });

  it('packs accepted events into messages of at most 25 with the context taken from the request, not the body', async () => {
    const q = fakeQueue();
    const events = Array.from({ length: 60 }, () => ev({ properties: { browser: 'forged', country: 'XX' } }));
    const res = await post('/v1/events/batch', a.publishableKey, { events, context: { browser: 'forged' } }, { overrides: { EVENTS_QUEUE: q }, headers: { 'user-agent': CHROME_MAC } });
    expect(await json(res)).toMatchObject({ accepted: 60 });
    expect(q.bodies.map((m) => m.events.length)).toEqual([EVENTS_PER_QUEUE_MESSAGE, EVENTS_PER_QUEUE_MESSAGE, 10]);
    for (const m of q.bodies) {
      expect(m).toMatchObject({ v: 2, product_id: 'col_a', environment: 'prod', context: { source: 'client', browser: 'chrome', os: 'macos', device: 'desktop', country: '' }, dimensions: [] });
    }
  });

  it('includes the declared custom dimensions of the product env; service-key events carry no device context', async () => {
    await env.INGEST_DB.prepare(`INSERT OR REPLACE INTO analytics_settings (product_env_id, dimensions, updated_at) VALUES (?, '["plan"]', 0)`).bind(b.productEnvId).run();
    const q = fakeQueue();
    const sk = await seedServiceKey(b.productEnvId, ['events:write']);
    await post('/v1/events/batch', sk, { events: [ev()] }, { overrides: { EVENTS_QUEUE: q }, headers: { 'user-agent': CHROME_MAC } });
    expect(q.bodies[0]).toMatchObject({ product_id: 'col_b', dimensions: ['plan'], context: { source: 'server', browser: '', os: '', device: '', country: '' } });
  });
});

describe('service-key user attribution', () => {
  it('accepts user_id only for active members of the key\'s product and queues the HMAC, never the id', async () => {
    const sk = await seedServiceKey(a.productEnvId, ['events:write']);
    const member = newUserId();
    const suspended = newUserId();
    const onlyInB = newUserId();
    await seedMembership(member, a.productId);
    await seedMembership(suspended, a.productId, 'suspended');
    await seedMembership(onlyInB, b.productId);
    const q = fakeQueue();
    const res = await post('/v1/events/batch', sk, {
      events: [ev({ user_id: member }), ev({ user_id: suspended }), ev({ user_id: onlyInB }), ev({ anonymous_id: 'dev-1' })],
    }, { overrides: { EVENTS_QUEUE: q } });
    const body = await json(res);
    expect(body.accepted).toBe(2);
    expect(body.rejected.map((r: any) => [r.index, r.code])).toEqual([[1, 'membership_required'], [2, 'membership_required']]);
    expect(q.events.map((e) => e.user_key)).toEqual([await userKey(member, a.salt), null]);
    for (const id of [member, suspended, onlyInB]) expect(JSON.stringify(q.bodies)).not.toContain(id);
    expect(q.events.every((e) => !('user_id' in e.event))).toBe(true);
  });
});

describe('POST /v1/events/user-properties', () => {
  const props = (key: string, body: unknown, headers?: Record<string, string>) => post('/v1/events/user-properties', key, body, { headers });
  const stored = async (productEnvId: string, key: string) =>
    (await env.INGEST_DB.prepare('SELECT properties FROM user_properties WHERE product_env_id = ? AND user_key = ?').bind(productEnvId, key).first<{ properties: string }>())?.properties;

  it('merges (null deletes) the signed-in user\'s properties under the per-product user_key', async () => {
    const u = await userFor(a);
    const auth = { Authorization: `Bearer ${u.token}` };
    expect(await json(await props(a.publishableKey, { properties: { plan: 'pro', level: 3 } }, auth))).toEqual({ properties: { plan: 'pro', level: 3 } });
    expect(await json(await props(a.publishableKey, { properties: { level: null, beta: true } }, auth))).toEqual({ properties: { plan: 'pro', beta: true } });
    expect(JSON.parse((await stored(a.productEnvId, await userKey(u.userId, a.salt)))!)).toEqual({ plan: 'pro', beta: true });
    const all = await env.INGEST_DB.prepare('SELECT properties, user_key FROM user_properties').all();
    expect(JSON.stringify(all.results)).not.toContain(u.userId);
  });

  it('requires a user: anonymous publishable calls are 401, a body user_id with a publishable key is 400', async () => {
    expect(await errorCode(await props(a.publishableKey, { properties: { plan: 'x' } }))).toBe('unauthenticated');
    const u = await userFor(a);
    expect(await errorCode(await props(a.publishableKey, { properties: { plan: 'x' }, user_id: u.userId }, { Authorization: `Bearer ${u.token}` }))).toBe('validation_failed');
  });

  it('service keys name a member of their own product; other products\' users are refused', async () => {
    const sk = await seedServiceKey(a.productEnvId, ['events:write']);
    const member = newUserId();
    await seedMembership(member, a.productId);
    expect((await props(sk, { properties: { tier: 'gold' }, user_id: member })).status).toBe(200);
    expect(await errorCode(await props(sk, { properties: { tier: 'gold' } }))).toBe('validation_failed');
    const other = newUserId();
    await seedMembership(other, b.productId);
    expect(await errorCode(await props(sk, { properties: { tier: 'gold' }, user_id: other }))).toBe('membership_required');
    expect(await stored(b.productEnvId, await userKey(other, b.salt))).toBeUndefined();
    expect(await errorCode(await props(await seedServiceKey(a.productEnvId, ['logs:write']), { properties: { x: 1 }, user_id: member }))).toBe('forbidden');
  });

  it("rejects A's user token with B's key", async () => {
    const u = await userFor(a);
    await seedMembership(u.userId, b.productId);
    expect(await errorCode(await props(b.publishableKey, { properties: { plan: 'x' } }, { Authorization: `Bearer ${u.token}` }))).toBe('invalid_token');
    expect(await stored(b.productEnvId, await userKey(u.userId, b.salt))).toBeUndefined();
  });

  it('enforces key format, value types and the 20-key / 2 KB limits without changing stored properties', async () => {
    const u = await userFor(a);
    const auth = { Authorization: `Bearer ${u.token}` };
    expect(await errorCode(await props(a.publishableKey, { properties: { 'bad key': 1 } }, auth))).toBe('validation_failed');
    expect(await errorCode(await props(a.publishableKey, { properties: { nested: { a: 1 } } }, auth))).toBe('validation_failed');
    expect(await errorCode(await props(a.publishableKey, { properties: { s: 'x'.repeat(257) } }, auth))).toBe('validation_failed');
    await props(a.publishableKey, { properties: { keep: 1 } }, auth);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(await errorCode(await props(a.publishableKey, { properties: many }, auth))).toBe('payload_too_large');
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'x'.repeat(250)]));
    expect(await errorCode(await props(a.publishableKey, { properties: big }, auth))).toBe('payload_too_large');
    expect(JSON.parse((await stored(a.productEnvId, await userKey(u.userId, a.salt)))!)).toEqual({ keep: 1 });
  });
});
