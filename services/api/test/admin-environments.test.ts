// Admin API: environment settings (GET/PATCH /v1/admin/products/:id/environments/:env, PRD §19.11).
import { DEFAULT_DAILY_UPLOAD_BYTES } from '@z-cloudbase/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { api, auditRows, dbValue, errorCode, initApp, makeWorld, type Json, type World } from './admin-helpers.ts';
import { minter } from './helpers.ts';

vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, upsertProductClient: async () => ({ clientId: 'x', resource: 'y' }) }),
}));

let w: World;
beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('envs');
});

const path = (p: string, e = 'dev') => `/products/${p}/environments/${e}`;

describe('environment settings', () => {
  it('returns defaults, then updates only the given fields and audits before/after', async () => {
    const before = (await (await api(w.tok.devA, 'GET', path(w.a))).json()) as Json;
    expect(before).toMatchObject({ allowed_extensions: [], allowed_mime_types: [], daily_upload_quota_bytes: DEFAULT_DAILY_UPLOAD_BYTES, unknown_event_policy: 'accept' });

    const res = await api(w.tok.adminA, 'PATCH', path(w.a), { allowed_extensions: ['png', 'jpg'], daily_upload_quota_bytes: 5000, unknown_event_policy: 'reject' });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Json;
    expect(after).toMatchObject({ allowed_extensions: ['png', 'jpg'], daily_upload_quota_bytes: 5000, unknown_event_policy: 'reject' });
    expect(after.storage_quota_bytes).toBe(before.storage_quota_bytes);
    expect(after.max_object_bytes).toBe(before.max_object_bytes);

    const [audit] = await auditRows('environment.update', w.a);
    expect(audit).toBeDefined();
    const meta = JSON.parse(audit!.metadata as string);
    expect(meta.before).toEqual({ allowed_extensions: [], daily_upload_quota_bytes: DEFAULT_DAILY_UPLOAD_BYTES, unknown_event_policy: 'accept' });
    expect(meta.after).toEqual({ allowed_extensions: ['png', 'jpg'], daily_upload_quota_bytes: 5000, unknown_event_policy: 'reject' });
  });

  it('only changes the addressed environment', async () => {
    await api(w.tok.adminA, 'PATCH', path(w.a, 'staging'), { max_object_bytes: 123, allowed_mime_types: ['image/*'] });
    expect(await dbValue('SELECT max_object_bytes AS m FROM product_environments WHERE id = ?', w.envs.a.staging)).toEqual({ m: 123 });
    expect((await dbValue('SELECT max_object_bytes AS m FROM product_environments WHERE id = ?', w.envs.a.prod))!.m).not.toBe(123);
  });

  it('validates input', async () => {
    for (const body of [{}, { allowed_extensions: ['.png'] }, { allowed_extensions: ['PNG'] }, { daily_upload_quota_bytes: 0 }, { unknown_event_policy: 'maybe' }]) {
      expect([JSON.stringify(body), await errorCode(await api(w.tok.adminA, 'PATCH', path(w.a), body))]).toEqual([JSON.stringify(body), 'validation_failed']);
    }
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', path(w.a, 'qa'), { max_object_bytes: 1 }))).toBe('validation_failed');
    expect(await errorCode(await api(w.tok.adminA, 'PATCH', path('nope_product'), { max_object_bytes: 1 }))).toBe('forbidden');
  });

  it('requires product:write; other products and non-members are denied', async () => {
    expect(await errorCode(await api(w.tok.devA, 'PATCH', path(w.a), { max_object_bytes: 1 }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'PATCH', path(w.a), { max_object_bytes: 1 }))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.adminB, 'GET', path(w.a)))).toBe('forbidden');
    expect(await errorCode(await api(w.tok.nobody, 'GET', path(w.a)))).toBe('forbidden');
    expect((await api(w.tok.owner, 'PATCH', path(w.a, 'prod'), { max_object_bytes: 7 })).status).toBe(200);
  });

  it('is listed with the product', async () => {
    const product = (await (await api(w.tok.adminB, 'GET', `/products/${w.b}`)).json()) as Json;
    expect(product.environments[0]).toMatchObject({ allowed_extensions: [], daily_upload_quota_bytes: DEFAULT_DAILY_UPLOAD_BYTES });
  });
});
