// Per-environment extension allowlist and daily upload quota on POST /v1/storage/uploads (PRD §19.11).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, errCode, seedBucket } from './api-helpers.ts';
import { seedProduct, userFor } from './helpers.ts';

async function setup(productId: string, settings: { exts?: string[]; daily?: number; quotaBytes?: number } = {}) {
  const p = await seedProduct({ productId, quotaBytes: settings.quotaBytes });
  await seedBucket(p.productEnvId, 'files');
  await env.DB.prepare('UPDATE product_environments SET allowed_extensions = ?, daily_upload_quota_bytes = COALESCE(?, daily_upload_quota_bytes) WHERE id = ?')
    .bind(JSON.stringify(settings.exts ?? []), settings.daily ?? null, p.productEnvId).run();
  const u = await userFor(p);
  const up = (body: Record<string, unknown>) =>
    call('/v1/storage/uploads', { key: p.publishableKey, token: u.token, body: { bucket: 'files', filename: 'a.txt', content_type: 'text/plain', size: 5, ...body } });
  return { p, u, up };
}

describe('extension allowlist', () => {
  it('empty list allows any filename, including ones without extension', async () => {
    const { up } = await setup('xl_any');
    expect((await up({ filename: 'a.EXE' })).status).toBe(201);
    expect((await up({ filename: 'README' })).status).toBe(201);
  });

  it('compares the last extension, case-insensitively', async () => {
    const { up } = await setup('xl_set', { exts: ['png', 'txt'] });
    expect((await up({ filename: 'a.txt' })).status).toBe(201);
    expect((await up({ filename: 'Photo.PNG', content_type: 'image/png' })).status).toBe(201);
    expect((await up({ filename: 'a.txt.exe' })).status).toBe(422);
    expect(await errCode(await up({ filename: 'a.exe' }))).toBe('unsupported_type');
    expect(await errCode(await up({ filename: 'noext' }))).toBe('unsupported_type');
    expect(await errCode(await up({ filename: 'trailing.' }))).toBe('unsupported_type');
    expect(await errCode(await up({ filename: '.txt' }))).toBe('unsupported_type'); // dotfile, not an extension
  });

  it('is enforced alongside the MIME allowlist (both must pass)', async () => {
    const p = await seedProduct({ productId: 'xl_both', allowedMimeTypes: ['image/*'] });
    await seedBucket(p.productEnvId, 'files');
    await env.DB.prepare(`UPDATE product_environments SET allowed_extensions = '["png"]' WHERE id = ?`).bind(p.productEnvId).run();
    const u = await userFor(p);
    const up = (body: Record<string, unknown>) => call('/v1/storage/uploads', { key: p.publishableKey, token: u.token, body: { bucket: 'files', size: 5, ...body } });
    expect((await up({ filename: 'a.png', content_type: 'image/png' })).status).toBe(201);
    expect(await errCode(await up({ filename: 'a.png', content_type: 'text/plain' }))).toBe('unsupported_type');
    expect(await errCode(await up({ filename: 'a.gif', content_type: 'image/gif' }))).toBe('unsupported_type');
  });

  it("one environment's settings never apply to another", async () => {
    const a = await setup('xl_iso_a', { exts: ['png'] });
    const b = await setup('xl_iso_b');
    expect((await a.up({ filename: 'a.txt' })).status).toBe(422);
    expect((await b.up({ filename: 'a.txt' })).status).toBe(201);
  });
});

describe('daily upload quota', () => {
  it('rejects uploads beyond the day total with quota_exceeded, counting pending ones', async () => {
    const { up } = await setup('dq_basic', { daily: 10 });
    expect((await up({ size: 6 })).status).toBe(201);
    const over = await up({ size: 5 });
    expect(over.status).toBe(422);
    expect(await errCode(over)).toBe('quota_exceeded');
    expect((await up({ size: 4 })).status).toBe(201);
    expect(await errCode(await up({ size: 1 }))).toBe('quota_exceeded');
  });

  it('deleting an object does not refill the day', async () => {
    const { p, u, up } = await setup('dq_delete', { daily: 10 });
    const first = (await (await up({ size: 10 })).json()) as { object_id: string };
    await env.DB.prepare(`UPDATE storage_objects SET status = 'available' WHERE id = ?`).bind(first.object_id).run();
    const del = await call(`/v1/storage/objects/${first.object_id}`, { method: 'DELETE', key: p.publishableKey, token: u.token });
    expect(del.status).toBeLessThan(300);
    expect(await env.DB.prepare('SELECT status FROM storage_objects WHERE id = ?').bind(first.object_id).first()).toEqual({ status: 'deleted' });
    expect(await errCode(await up({ size: 1 }))).toBe('quota_exceeded');
  });

  it('only counts uploads created today (UTC)', async () => {
    const { p, up } = await setup('dq_day', { daily: 10 });
    expect((await up({ size: 10 })).status).toBe(201);
    expect(await errCode(await up({ size: 1 }))).toBe('quota_exceeded');
    await env.DB.prepare('UPDATE storage_objects SET created_at = created_at - 86400000 * 2 WHERE product_env_id = ?').bind(p.productEnvId).run();
    expect((await up({ size: 10 })).status).toBe(201);
  });

  it('is per environment: another product is unaffected', async () => {
    const a = await setup('dq_iso_a', { daily: 5 });
    const b = await setup('dq_iso_b');
    expect((await a.up({ size: 5 })).status).toBe(201);
    expect(await errCode(await a.up({ size: 1 }))).toBe('quota_exceeded');
    expect((await b.up({ size: 50 })).status).toBe(201);
  });

  it('defaults to 1 GB', async () => {
    await setup('dq_default');
    const row = await env.DB.prepare(`SELECT daily_upload_quota_bytes AS d FROM product_environments WHERE id = 'dq_default.prod'`).first<{ d: number }>();
    expect(row!.d).toBe(1024 ** 3);
  });
});
