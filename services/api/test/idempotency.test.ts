// Idempotency-Key on POST /v1/storage/uploads (PRD §19.5): replay, conflict, scoping, expiry.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, errCode, seedBucket } from './api-helpers.ts';
import { seedProduct, seedServiceKey, userFor, type SeededEnv } from './helpers.ts';

let p: SeededEnv;
let u1: { userId: string; token: string };
let u2: { userId: string; token: string };
beforeAll(async () => {
  p = await seedProduct({ productId: 'idem_a', quotaBytes: 100 });
  await seedBucket(p.productEnvId, 'files');
  u1 = await userFor(p);
  u2 = await userFor(p);
});

const body = (extra: Record<string, unknown> = {}) => ({ bucket: 'files', filename: 'a.txt', content_type: 'text/plain', size: 10, ...extra });
const post = (token: string, key: string | undefined, b: unknown, path = '/v1/storage/uploads') =>
  call(path, { key: p.publishableKey, token, body: b, headers: key ? { 'Idempotency-Key': key } : undefined });
const countObjects = async (owner: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM storage_objects WHERE owner_user_id = ?').bind(owner).first<{ n: number }>())!.n;

describe('Idempotency-Key', () => {
  it('replays the stored response for the same key and body without creating a second object', async () => {
    const first = await post(u1.token, 'k-replay', body());
    const second = await post(u1.token, 'k-replay', body());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(await second.json()).toEqual(await first.json());
    expect(await countObjects(u1.userId)).toBe(1);
  });

  it('rejects the same key with a different body as idempotency_conflict', async () => {
    expect((await post(u1.token, 'k-conflict', body())).status).toBe(201);
    const res = await post(u1.token, 'k-conflict', body({ size: 11 }));
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('idempotency_conflict');
  });

  it('scopes keys per principal and route: another user or credential does not collide or replay', async () => {
    const a = (await (await post(u1.token, 'k-scope', body())).json()) as { object_id: string };
    const b = await post(u2.token, 'k-scope', body({ size: 12 }));
    expect(b.status).toBe(201);
    expect(((await b.json()) as { object_id: string }).object_id).not.toBe(a.object_id);

    const sk = await seedServiceKey(p.productEnvId, ['storage:write']);
    const c = await call('/v1/storage/uploads', { key: sk, body: body({ size: 13 }), headers: { 'Idempotency-Key': 'k-scope' } });
    expect(c.status).toBe(201);
    expect(((await c.json()) as { object_id: string }).object_id).not.toBe(a.object_id);
  });

  it('runs every request when no key is sent', async () => {
    await post(u2.token, undefined, body({ size: 1 }));
    const before = await countObjects(u2.userId);
    await post(u2.token, undefined, body({ size: 1 }));
    expect(await countObjects(u2.userId)).toBe(before + 1);
  });

  it('does not store failed responses, so a corrected retry with the same key works', async () => {
    const u = await userFor(p);
    const bad = await post(u.token, 'k-fail', body({ size: 1000 })); // over quota (100)
    expect(await errCode(bad)).toBe('quota_exceeded');
    const retry = await post(u.token, 'k-fail', body({ size: 1 }));
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
  });

  it('forgets keys after the TTL', async () => {
    const u = await userFor(p);
    await post(u.token, 'k-ttl', body({ size: 1 }));
    await env.DB.prepare(`UPDATE idempotency_keys SET expires_at = ? WHERE key = 'k-ttl'`).bind(Date.now() - 1).run();
    const again = await post(u.token, 'k-ttl', body({ size: 2 }));
    expect(again.status).toBe(201); // different body is fine once the key expired
    expect(await countObjects(u.userId)).toBe(2);
  });

  it('stores keys with a 24 hour lifetime', async () => {
    const u = await userFor(p);
    await post(u.token, 'k-life', body({ size: 1 }));
    const row = await env.DB.prepare(`SELECT expires_at FROM idempotency_keys WHERE key = 'k-life'`).first<{ expires_at: number }>();
    const left = row!.expires_at - Date.now();
    expect(left).toBeGreaterThan(23.9 * 3600_000);
    expect(left).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('treats a concurrent duplicate whose first request is still running as a retryable conflict', async () => {
    const u = await userFor(p);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body({ size: 1 }))));
    const hex = [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(`INSERT INTO idempotency_keys (principal, route, key, request_hash, status_code, response_body, expires_at) VALUES (?, ?, ?, ?, 0, '', ?)`)
      .bind(`pk:${p.productEnvId}:${u.userId}`, 'POST /v1/storage/uploads', 'k-inflight', hex, Date.now() + 30_000).run();
    const res = await post(u.token, 'k-inflight', body({ size: 1 }));
    expect(res.status).toBe(409);
    const err = ((await res.json()) as { error: { code: string; retryable: boolean } }).error;
    expect(err).toMatchObject({ code: 'idempotency_conflict', retryable: true });
  });

  it('validates the header length', async () => {
    expect(await errCode(await post(u1.token, 'x'.repeat(256), body()))).toBe('validation_failed');
  });
});
