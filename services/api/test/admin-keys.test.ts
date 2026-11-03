// Admin API: service keys, publishable key rotation, buckets and event schemas.
import { SERVICE_KEY_RE } from '@z-cloudbase/contracts';
import { errorHandler, requestId, sha256Hex } from '@z-cloudbase/security';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import type { AppEnv } from '../src/context.ts';
import { withCredential } from '../src/middleware/auth.ts';
import { api, auditRows, dbValue, errorCode, initApp, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks }),
}));

let w: World;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('key');
});

const probe = new Hono<AppEnv>();
probe.use(requestId());
probe.onError(errorHandler);
probe.get('/probe', withCredential({ allow: ['publishable', 'service'] }), (c) => c.json({ product: c.get('cred').productId, env: c.get('cred').env }));
const probeWith = (key: string) => probe.request('/probe', { headers: { 'X-Platform-Key': key } }, env);

const create = (t: string, productId: string, body: unknown) => api(t, 'POST', `/products/${productId}/service-keys`, body);

describe('service keys', () => {
  it('returns the plaintext once, stores only its hash, and the key authenticates as that product/env', async () => {
    const res = await create(w.tok.adminA, w.a, { env: 'prod', scopes: ['storage:read', 'logs:write'], label: 'backend' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Json;
    expect(created.key).toMatch(SERVICE_KEY_RE);
    expect(created.key.startsWith('sk_prod_')).toBe(true);

    const row = (await dbValue('SELECT * FROM service_credentials WHERE id = ?', created.id))!;
    expect(row.secret_hash).toBe(await sha256Hex(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.product_env_id).toBe(w.envs.a.prod);
    expect(row.created_by).toBe(w.users.adminA);
    expect(await (await probeWith(created.key)).json()).toEqual({ product: w.a, env: 'prod' });

    // The listing never exposes secrets or hashes.
    const list = await (await api(w.tok.adminA, 'GET', `/products/${w.a}/service-keys`)).text();
    expect(list).toContain(created.id);
    expect(list).not.toContain(created.key);
    expect(list).not.toContain(row.secret_hash);

    // Audit records the action without the secret.
    const audit = await auditRows('service_key.create', w.a);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(created.key);
    expect(JSON.parse(audit[0]!.metadata)).toEqual({ scopes: ['storage:read', 'logs:write'], label: 'backend' });
  });

  it('validates scopes, env and body', async () => {
    expect(await errorCode(await create(w.tok.owner, w.a, { env: 'prod', scopes: [] }))).toBe('validation_failed');
    expect(await errorCode(await create(w.tok.owner, w.a, { env: 'prod', scopes: ['admin:everything'] }))).toBe('validation_failed');
    expect(await errorCode(await create(w.tok.owner, w.a, { env: 'qa', scopes: ['logs:write'] }))).toBe('validation_failed');
    expect(await errorCode(await create(w.tok.owner, 'key_missing', { env: 'prod', scopes: ['logs:write'] }))).toBe('not_found');
  });

  it('keeps production keys away from developers but lets them manage dev/staging keys', async () => {
    expect(await errorCode(await create(w.tok.devA, w.a, { env: 'prod', scopes: ['logs:write'] }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.devA, 'GET', `/products/${w.a}/service-keys?env=prod`))).toBe('forbidden');
    expect((await create(w.tok.devA, w.a, { env: 'dev', scopes: ['logs:write'] })).status).toBe(201);
    expect((await create(w.tok.devA, w.a, { env: 'staging', scopes: ['logs:write'] })).status).toBe(201);

    // Without ?env= a developer's listing silently omits production keys.
    const prodKey = (await (await create(w.tok.adminA, w.a, { env: 'prod', scopes: ['events:write'], label: 'prod-only' })).json()) as Json;
    const seen = ((await (await api(w.tok.devA, 'GET', `/products/${w.a}/service-keys`)).json()) as Json).keys as Json[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((k) => k.env !== 'prod')).toBe(true);
    expect(seen.some((k) => k.id === prodKey.id)).toBe(false);
    expect(await dbValue('SELECT 1 AS x FROM service_credentials WHERE created_by = ? AND product_env_id = ?', w.users.devA, w.envs.a.prod)).toBeNull();
  });

  it('operators cannot create, list or revoke keys', async () => {
    expect(await errorCode(await create(w.tok.operator, w.a, { env: 'dev', scopes: ['logs:write'] }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.operator, 'GET', `/products/${w.a}/service-keys`))).toBe('forbidden');
  });

  it('revokes immediately, idempotently, and audits', async () => {
    const k = (await (await create(w.tok.adminA, w.a, { env: 'dev', scopes: ['logs:write'] })).json()) as Json;
    expect((await probeWith(k.key)).status).toBe(200);
    const first = await api(w.tok.adminA, 'DELETE', `/products/${w.a}/service-keys/${k.id}`);
    expect(first.status).toBe(200);
    const revokedAt = ((await first.json()) as Json).revoked_at;
    expect(await errorCode(await probeWith(k.key))).toBe('unauthenticated');
    const again = (await (await api(w.tok.adminA, 'DELETE', `/products/${w.a}/service-keys/${k.id}`)).json()) as Json;
    expect(again.revoked_at).toBe(revokedAt);
    expect((await auditRows('service_key.revoke', w.a)).some((r) => r.target_id === k.id)).toBe(true);
    expect(await errorCode(await api(w.tok.adminA, 'DELETE', `/products/${w.a}/service-keys/cred_missing`))).toBe('not_found');
  });

  it('a developer cannot revoke a production key', async () => {
    const k = (await (await create(w.tok.adminA, w.a, { env: 'prod', scopes: ['logs:write'] })).json()) as Json;
    expect(await errorCode(await api(w.tok.devA, 'DELETE', `/products/${w.a}/service-keys/${k.id}`))).toBe('forbidden');
    expect((await probeWith(k.key)).status).toBe(200);
  });

  it("cross-product: B's admin can neither create, list nor revoke A's keys, whether by path or by key id", async () => {
    const k = (await (await create(w.tok.adminA, w.a, { env: 'dev', scopes: ['logs:write'] })).json()) as Json;
    const before = (await dbValue<{ n: number }>('SELECT COUNT(*) AS n FROM service_credentials WHERE product_env_id = ?', w.envs.a.dev))!.n;
    expect(await errorCode(await create(w.tok.adminB, w.a, { env: 'dev', scopes: ['logs:write'] }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'GET', `/products/${w.a}/service-keys`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'DELETE', `/products/${w.a}/service-keys/${k.id}`))).toBe('forbidden');
    // Using one's own product in the path with another product's key id finds nothing.
    expect(await errorCode(await api(w.tok.adminB, 'DELETE', `/products/${w.b}/service-keys/${k.id}`))).toBe('not_found');
    expect(await errorCode(await api(w.tok.owner, 'DELETE', `/products/${w.b}/service-keys/${k.id}`))).toBe('not_found');
    expect((await probeWith(k.key)).status).toBe(200);
    expect((await dbValue<{ n: number }>('SELECT COUNT(*) AS n FROM service_credentials WHERE product_env_id = ?', w.envs.a.dev))!.n).toBe(before);
  });
});

describe('publishable key rotation', () => {
  const pkOf = async (envId: string) => (await dbValue<{ publishable_key: string }>('SELECT publishable_key FROM product_environments WHERE id = ?', envId))!.publishable_key;

  it('replaces the key: the old one stops working at once, the new one works', async () => {
    const old = await pkOf(w.envs.a.staging);
    expect((await probeWith(old)).status).toBe(200);
    const res = await api(w.tok.adminA, 'POST', `/products/${w.a}/environments/staging/publishable-key/rotate`);
    expect(res.status).toBe(200);
    const { publishable_key } = (await res.json()) as Json;
    expect(publishable_key).toMatch(/^pk_staging_/);
    expect(publishable_key).not.toBe(old);
    expect(await errorCode(await probeWith(old))).toBe('unauthenticated');
    expect(await (await probeWith(publishable_key)).json()).toEqual({ product: w.a, env: 'staging' });
    expect(await auditRows('publishable_key.rotate', w.a)).toHaveLength(1);
  });

  it('is denied to developers on prod, to operators, and across products; other environments are untouched', async () => {
    const prodBefore = await pkOf(w.envs.a.prod);
    expect(await errorCode(await api(w.tok.devA, 'POST', `/products/${w.a}/environments/prod/publishable-key/rotate`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.operator, 'POST', `/products/${w.a}/environments/dev/publishable-key/rotate`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'POST', `/products/${w.a}/environments/dev/publishable-key/rotate`))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.owner, 'POST', `/products/${w.a}/environments/qa/publishable-key/rotate`))).toBe('validation_failed');
    expect(await pkOf(w.envs.a.prod)).toBe(prodBefore);
    expect((await api(w.tok.devA, 'POST', `/products/${w.a}/environments/dev/publishable-key/rotate`)).status).toBe(200);
  });
});

describe('buckets', () => {
  const base = (p: string, e = 'dev') => `/products/${p}/environments/${e}/buckets`;

  it('creates and lists buckets per environment', async () => {
    const res = await api(w.tok.adminA, 'POST', base(w.a), { name: 'avatars' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Json).visibility).toBe('private');
    await api(w.tok.adminA, 'POST', base(w.a, 'prod'), { name: 'prod-docs', visibility: 'public' });

    const dev = ((await (await api(w.tok.adminA, 'GET', base(w.a))).json()) as Json).buckets.map((b: Json) => b.name);
    expect(dev).toEqual(['avatars']);
    // Read access for developers and operators, but they cannot create.
    for (const t of [w.tok.devA, w.tok.operator]) expect((await api(t, 'GET', base(w.a))).status).toBe(200);
    for (const t of [w.tok.devA, w.tok.operator]) expect(await errorCode(await api(t, 'POST', base(w.a), { name: 'sneaky' }))).toBe('forbidden');
    expect((await auditRows('bucket.create', w.a)).length).toBe(2);
  });

  it('rejects duplicate and malformed names', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { name: 'avatars' }))).toBe('conflict');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { name: 'Bad Name!' }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { name: 'ok', visibility: 'secret' }))).toBe('validation_failed');
  });

  it("cannot be created or listed in another product's environments", async () => {
    expect(await errorCode(await api(w.tok.adminB, 'POST', base(w.a), { name: 'intruder' }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'GET', base(w.a)))).toBe('forbidden');
    expect(await dbValue('SELECT 1 AS x FROM storage_buckets WHERE name = ?', 'intruder')).toBeNull();
    // Same bucket name in two products is fine and stays separate.
    expect((await api(w.tok.adminB, 'POST', base(w.b), { name: 'avatars' })).status).toBe(201);
    expect(((await (await api(w.tok.adminB, 'GET', base(w.b))).json()) as Json).buckets).toHaveLength(1);
  });
});

describe('event schemas', () => {
  const base = (p: string, e = 'dev') => `/products/${p}/environments/${e}/event-schemas`;
  const schema = { properties: { plan: { type: 'string', required: true } }, additional_properties: false };

  it('registers versions and lists them', async () => {
    const res = await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'checkout_done', schema_version: 1, schema: schema });
    expect(res.status).toBe(201);
    expect((await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'checkout_done', schema_version: 2, schema: schema })).status).toBe(201);
    const list = ((await (await api(w.tok.devA, 'GET', base(w.a))).json()) as Json).event_schemas as Json[];
    expect(list.map((s) => [s.event_name, s.schema_version])).toEqual([['checkout_done', 1], ['checkout_done', 2]]);
    expect(list[0]!.schema).toEqual(schema);
    expect(await auditRows('event_schema.register', w.a)).toHaveLength(2);
  });

  it('rejects schemas outside the supported subset and missing versions', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'sub_event', schema: { properties: { x: { type: 'object' } } } }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'sub_event', schema_version: 1, schema: { properties: { x: { type: 'string', max_length: 5000 } } } }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'sub_event', schema: schema }))).toBe('validation_failed'); // schema_version is required
  });

  it('rejects duplicates, bad names, and developers', async () => {
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'checkout_done', schema_version: 1, schema: schema }))).toBe('conflict');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'Bad Name', schema_version: 1, schema: schema }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'POST', base(w.a), { event_name: 'ok_event', schema_version: 1, schema: 'nope' }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.devA, 'POST', base(w.a), { event_name: 'dev_event', schema_version: 1, schema: schema }))).toBe('forbidden');
  });

  it("is isolated per product", async () => {
    expect(await errorCode(await api(w.tok.adminB, 'GET', base(w.a)))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'POST', base(w.a), { event_name: 'steal', schema_version: 1, schema: schema }))).toBe('forbidden');
    expect(((await (await api(w.tok.adminB, 'GET', base(w.b))).json()) as Json).event_schemas).toEqual([]);
  });
});
