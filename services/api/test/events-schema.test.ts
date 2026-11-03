// Event property schema enforcement on POST /v1/events/batch (PRD §19.11).
import { newId, uuidv7 } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeQueue, post } from './ingest-helpers.ts';
import { seedProduct } from './helpers.ts';

const ev = (over: Record<string, unknown> = {}) => ({
  event_id: uuidv7(), event_name: 'upgrade', occurred_at: new Date().toISOString(), anonymous_id: 'anon-1', properties: {}, ...over,
});
const send = (key: string, events: unknown[], q = fakeQueue()) => post('/v1/events/batch', key, { events }, { overrides: { EVENTS_QUEUE: q } });
const json = async (res: Response) => (await res.json()) as any;

const schema = {
  properties: { plan: { type: 'string', required: true, enum: ['free', 'pro'] }, amount: { type: 'number', minimum: 0 } },
  additional_properties: false,
};
const register = (productEnvId: string, name: string, version: number, s: unknown = schema) =>
  env.DB.prepare('INSERT INTO event_schemas (id, product_env_id, event_name, schema_version, json_schema, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId('evs'), productEnvId, name, version, JSON.stringify(s), Date.now()).run();
const good = { plan: 'pro', amount: 3 };
const bad = { plan: 'gold', extra: true };

describe('event property schemas', () => {
  it('dev/staging accept violating events with a schema_violation warning listing the fields', async () => {
    const dev = await seedProduct({ productId: 'evs_dev', env: 'dev' });
    await register(dev.productEnvId, 'upgrade', 1);
    const q = fakeQueue();
    const body = await json(await send(dev.publishableKey, [ev({ properties: good }), ev({ properties: bad })], q));
    expect(body.accepted).toBe(2);
    expect(body.rejected).toEqual([]);
    expect(body.warnings).toEqual([{ index: 1, code: 'schema_violation', message: expect.stringMatching(/plan.*extra: not allowed/) }]);
    expect(q.bodies).toHaveLength(2);
  });

  it('prod rejects only the violating event, and the rejection does not consume its dedupe slot', async () => {
    const prod = await seedProduct({ productId: 'evs_prod' });
    await register(prod.productEnvId, 'upgrade', 1);
    const q = fakeQueue();
    const violating = ev({ properties: bad });
    const body = await json(await send(prod.publishableKey, [ev({ properties: good }), violating], q));
    expect(body.accepted).toBe(1);
    expect(body.rejected).toEqual([{ index: 1, code: 'schema_violation', message: expect.stringContaining('plan') }]);
    expect(body.warnings).toBeUndefined();
    expect(q.bodies.map((m) => m.event.properties)).toEqual([good]);
    const fixed = await json(await send(prod.publishableKey, [{ ...violating, properties: good }]));
    expect(fixed).toMatchObject({ accepted: 1, duplicate: 0 });
  });

  it("validates against the event's own version; an unregistered version follows the unknown-event policy", async () => {
    const prod = await seedProduct({ productId: 'evs_ver' });
    await register(prod.productEnvId, 'upgrade', 1);
    await register(prod.productEnvId, 'upgrade', 2, { properties: { tier: { type: 'string', required: true } } });
    const res = await json(await send(prod.publishableKey, [
      ev({ schema_version: 2, properties: { tier: 'x' } }),
      ev({ schema_version: 2, properties: good }),
      ev({ schema_version: 3, properties: bad }),
    ]));
    expect(res.accepted).toBe(2); // v2 valid + v3 unregistered (prod policy defaults to accept)
    expect(res.rejected).toEqual([{ index: 1, code: 'schema_violation', message: expect.stringContaining('tier: required') }]);

    await env.DB.prepare(`UPDATE product_environments SET unknown_event_policy = 'reject' WHERE id = ?`).bind(prod.productEnvId).run();
    const strict = await json(await send(prod.publishableKey, [ev({ schema_version: 3, properties: good })]));
    expect(strict.rejected).toEqual([{ index: 0, code: 'unknown_event', message: expect.any(String) }]);
  });

  it("does not apply another product's schema", async () => {
    const x = await seedProduct({ productId: 'evs_x' });
    const y = await seedProduct({ productId: 'evs_y' });
    await register(x.productEnvId, 'upgrade', 1);
    const res = await json(await send(y.publishableKey, [ev({ properties: bad })]));
    expect(res).toMatchObject({ accepted: 1, rejected: [] });
  });
});
