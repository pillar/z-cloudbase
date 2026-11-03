// /v1/storage: upload -> complete -> list/download -> delete, validation, ownership and cross-product isolation.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PNG, call, errCode, pathOf, seedBucket } from './api-helpers.ts';
import { seedMembership, seedProduct, seedServiceKey, userFor, type SeededEnv } from './helpers.ts';

let a: SeededEnv;
let b: SeededEnv;
let ua: { userId: string; token: string };
let ua2: { userId: string; token: string };
let ub: { userId: string; token: string };
let skA: string;
let skB: string;

beforeAll(async () => {
  a = await seedProduct({ productId: 'st_a', maxObjectBytes: 1000, allowedMimeTypes: ['image/*', 'text/plain'] });
  b = await seedProduct({ productId: 'st_b' });
  await seedBucket(a.productEnvId, 'files');
  await seedBucket(b.productEnvId, 'files');
  await seedBucket(b.productEnvId, 'private-b');
  ua = await userFor(a);
  ua2 = await userFor(a);
  ub = await userFor(b);
  skA = await seedServiceKey(a.productEnvId, ['storage:read', 'storage:write']);
  skB = await seedServiceKey(b.productEnvId, ['storage:read', 'storage:write']);
});

type Who = { key: string; token?: string };
const asUserA = (): Who => ({ key: a.publishableKey, token: ua.token });

async function createUpload(who: Who, body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  return call('/v1/storage/uploads', {
    ...who, headers,
    body: { bucket: 'files', filename: 'hello.txt', content_type: 'text/plain', size: 5, ...body },
  });
}

/** create + PUT to the signed URL; returns the object id */
async function uploadBytes(who: Who, bytes: Uint8Array, meta: { filename?: string; content_type: string; bucket?: string }) {
  const res = await createUpload(who, { ...meta, size: bytes.byteLength });
  expect(res.status).toBe(201);
  const up = (await res.json()) as { object_id: string; url: string; headers: Record<string, string> };
  const put = await call(pathOf(up.url), { method: 'PUT', rawBody: bytes, headers: up.headers });
  expect(put.status).toBe(200);
  return up.object_id;
}

const complete = (who: Who, id: string) => call(`/v1/storage/uploads/${id}/complete`, { ...who, method: 'POST' });
const text = (s: string) => new TextEncoder().encode(s);

async function availableObject(who: Who, content = 'hello', meta = { content_type: 'text/plain' }) {
  const id = await uploadBytes(who, text(content), meta);
  expect((await complete(who, id)).status).toBe(200);
  return id;
}

describe('upload lifecycle', () => {
  it('uploads, completes, lists, downloads and deletes an object, with an audit trail', async () => {
    const res = await createUpload(asUserA(), { filename: '../../etc/passwd' });
    expect(res.status).toBe(201);
    const up = (await res.json()) as { object_id: string; method: string; url: string; headers: Record<string, string>; expires_at: string };
    expect(up.method).toBe('PUT');
    const ttl = Date.parse(up.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    // The R2 key is server-generated; the (hostile) filename is metadata only.
    const row = await env.DB.prepare('SELECT object_key, filename, status FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string; filename: string; status: string }>();
    expect(row!.object_key).toBe(`st_a/prod/files/${ua.userId}/${up.object_id}`);
    expect(row!.filename).toBe('../../etc/passwd');
    expect(row!.status).toBe('pending');

    expect((await call(pathOf(up.url), { method: 'PUT', rawBody: text('hello'), headers: up.headers })).status).toBe(200);
    const done = await complete(asUserA(), up.object_id);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ id: up.object_id, bucket: 'files', size: 5, status: 'available', content_type: 'text/plain' });

    const list = (await (await call('/v1/storage/objects?bucket=files', asUserA())).json()) as { objects: { id: string }[]; next_cursor: string | null };
    expect(list.objects.map((o) => o.id)).toContain(up.object_id);

    const dl = (await (await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: up.object_id } })).json()) as { url: string; expires_at: string };
    const got = await call(pathOf(dl.url));
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('hello');

    const del = await call(`/v1/storage/objects/${up.object_id}`, { ...asUserA(), method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await env.STORAGE.head(row!.object_key)).toBeNull();
    const after = await env.DB.prepare('SELECT status, deleted_by FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ status: string; deleted_by: string }>();
    expect(after).toEqual({ status: 'deleted', deleted_by: ua.userId });
    const audit = await env.DB.prepare(`SELECT actor_type, actor_id, product_id, target_id FROM audit_log WHERE action = 'storage.object.delete' AND target_id = ?`).bind(up.object_id).first();
    expect(audit).toEqual({ actor_type: 'user', actor_id: ua.userId, product_id: 'st_a', target_id: up.object_id });

    expect(await errCode(await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: up.object_id } }))).toBe('not_found');
    expect(await errCode(await call(`/v1/storage/objects/${up.object_id}`, { ...asUserA(), method: 'DELETE' }))).toBe('not_found');
    const relist = (await (await call('/v1/storage/objects?bucket=files', asUserA())).json()) as { objects: { id: string }[] };
    expect(relist.objects.map((o) => o.id)).not.toContain(up.object_id);
  });

  it('lets a service key upload (service-owned) and manage objects of any user in its product', async () => {
    const sk = { key: skA };
    const id = await availableObject(sk);
    const row = await env.DB.prepare('SELECT object_key, owner_user_id FROM storage_objects WHERE id = ?').bind(id).first<{ object_key: string; owner_user_id: string | null }>();
    expect(row).toEqual({ object_key: `st_a/prod/files/_service/${id}`, owner_user_id: null });

    const userObj = await availableObject(asUserA());
    const dl = await call('/v1/storage/downloads', { ...sk, body: { object_id: userObj } });
    expect(dl.status).toBe(200);
    const listed = (await (await call('/v1/storage/objects?bucket=files&limit=100', sk)).json()) as { objects: { id: string }[] };
    expect(listed.objects.map((o) => o.id)).toEqual(expect.arrayContaining([id, userObj]));
    expect((await call(`/v1/storage/objects/${userObj}`, { ...sk, method: 'DELETE' })).status).toBe(204);
    const audit = await env.DB.prepare(`SELECT actor_type FROM audit_log WHERE action = 'storage.object.delete' AND target_id = ?`).bind(userObj).first();
    expect(audit).toEqual({ actor_type: 'service' });
  });

  it('paginates the listing with a cursor', async () => {
    const p = await seedProduct({ productId: 'st_page' });
    await seedBucket(p.productEnvId, 'files');
    const u = await userFor(p);
    const who = { key: p.publishableKey, token: u.token };
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) ids.push(await availableObject(who, `n${i}`));
    const first = (await (await call('/v1/storage/objects?bucket=files&limit=2', who)).json()) as { objects: { id: string }[]; next_cursor: string };
    expect(first.objects).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = (await (await call(`/v1/storage/objects?bucket=files&limit=2&cursor=${first.next_cursor}`, who)).json()) as { objects: { id: string }[]; next_cursor: string | null };
    expect(second.next_cursor).toBeNull();
    expect([...first.objects, ...second.objects].map((o) => o.id).sort()).toEqual([...ids].sort());
  });
});

describe('upload validation (PRD §19.5 / §19.6)', () => {
  it('rejects unknown buckets, bad bodies and non-JSON', async () => {
    expect(await errCode(await createUpload(asUserA(), { bucket: 'nope' }))).toBe('not_found');
    // A bucket that exists only in another product is also unknown here.
    expect(await errCode(await createUpload(asUserA(), { bucket: 'private-b' }))).toBe('not_found');
    expect(await errCode(await createUpload(asUserA(), { size: -1 }))).toBe('validation_failed');
    expect(await errCode(await createUpload(asUserA(), { filename: '' }))).toBe('validation_failed');
    expect(await errCode(await call('/v1/storage/uploads', { ...asUserA(), rawBody: 'not json', method: 'POST' }))).toBe('invalid_request');
  });

  it('enforces max object size and the MIME allowlist', async () => {
    const big = await createUpload(asUserA(), { size: 1001 });
    expect(big.status).toBe(413);
    expect(await errCode(big)).toBe('payload_too_large');
    expect((await createUpload(asUserA(), { size: 1000 })).status).toBe(201);
    const bad = await createUpload(asUserA(), { content_type: 'application/x-msdownload' });
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe('unsupported_type');
    expect((await createUpload(asUserA(), { content_type: 'image/png' })).status).toBe(201);
    expect((await createUpload(asUserA(), { content_type: 'Text/Plain; charset=utf-8' })).status).toBe(201);
  });

  it('enforces the product-env quota over pending + available objects,', async () => {
    const p = await seedProduct({ productId: 'st_quota', quotaBytes: 10 });
    await seedBucket(p.productEnvId, 'files');
    const u = await userFor(p);
    const who = { key: p.publishableKey, token: u.token };
    const first = await createUpload(who, { size: 6 }); // stays pending: still counts
    expect(first.status).toBe(201);
    const over = await createUpload(who, { size: 5 });
    expect(over.status).toBe(422);
    expect(await errCode(over)).toBe('quota_exceeded');
    expect((await createUpload(who, { size: 4 })).status).toBe(201);

    // Another product's usage is not counted against this one and vice versa.
    const q2 = await seedProduct({ productId: 'st_quota2', quotaBytes: 10 });
    await seedBucket(q2.productEnvId, 'files');
    const u2 = await userFor(q2);
    expect((await createUpload({ key: q2.publishableKey, token: u2.token }, { size: 10 })).status).toBe(201);
  });
});

describe('complete', () => {
  it('requires the file to be uploaded first and keeps the object pending', async () => {
    const up = (await (await createUpload(asUserA())).json()) as { object_id: string };
    expect(await errCode(await complete(asUserA(), up.object_id))).toBe('invalid_request');
    const row = await env.DB.prepare('SELECT status FROM storage_objects WHERE id = ?').bind(up.object_id).first();
    expect(row).toEqual({ status: 'pending' });
  });

  it('rejects and deletes an object whose size differs from the declaration', async () => {
    const up = (await (await createUpload(asUserA(), { size: 5 })).json()) as { object_id: string };
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string }>())!.object_key;
    await env.STORAGE.put(key, text('way too long'), { httpMetadata: { contentType: 'text/plain' } });
    expect(await errCode(await complete(asUserA(), up.object_id))).toBe('invalid_request');
    expect(await env.STORAGE.head(key)).toBeNull();
    expect(await env.DB.prepare('SELECT status FROM storage_objects WHERE id = ?').bind(up.object_id).first()).toEqual({ status: 'deleted' });
    // Never becomes downloadable.
    expect(await errCode(await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: up.object_id } }))).toBe('not_found');
  });

  it('rejects an object stored with a different content type than declared', async () => {
    const up = (await (await createUpload(asUserA(), { size: 5 })).json()) as { object_id: string };
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string }>())!.object_key;
    await env.STORAGE.put(key, text('hello'), { httpMetadata: { contentType: 'text/html' } });
    const res = await complete(asUserA(), up.object_id);
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('unsupported_type');
    expect(await env.STORAGE.head(key)).toBeNull();
  });

  it('sniffs image magic bytes: a PNG passes, text declared as image/png is rejected and removed', async () => {
    const good = await uploadBytes(asUserA(), PNG, { content_type: 'image/png', filename: 'a.png' });
    expect((await complete(asUserA(), good)).status).toBe(200);

    const fake = await uploadBytes(asUserA(), text('<html>not a png</html>'), { content_type: 'image/png', filename: 'a.png' });
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(fake).first<{ object_key: string }>())!.object_key;
    const res = await complete(asUserA(), fake);
    expect(await errCode(res)).toBe('unsupported_type');
    expect(await env.STORAGE.head(key)).toBeNull();
  });

  it('is safe to retry after success', async () => {
    const id = await availableObject(asUserA());
    const again = await complete(asUserA(), id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, status: 'available' });
  });
});

describe('downloads', () => {
  it('honours the ttl default and maximum', async () => {
    const id = await availableObject(asUserA());
    const ttl = async (seconds?: number) => {
      const res = await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: id, ...(seconds ? { ttl_seconds: seconds } : {}) } });
      return res.status === 200 ? Date.parse(((await res.json()) as { expires_at: string }).expires_at) - Date.now() : res;
    };
    expect(await ttl()).toBeGreaterThan(4 * 60_000);
    expect(await ttl()).toBeLessThanOrEqual(5 * 60_000);
    expect(await ttl(3600)).toBeLessThanOrEqual(3600_000);
    const tooLong = (await ttl(3601)) as Response;
    expect(await errCode(tooLong)).toBe('validation_failed');
  });

  it('does not issue downloads for pending objects', async () => {
    const up = (await (await createUpload(asUserA())).json()) as { object_id: string };
    expect(await errCode(await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: up.object_id } }))).toBe('not_found');
  });
});

describe('authentication and scopes', () => {
  it('requires a bearer token for publishable keys and the right scope for service keys', async () => {
    expect(await errCode(await createUpload({ key: a.publishableKey }))).toBe('unauthenticated');
    expect(await errCode(await call('/v1/storage/objects?bucket=files'))).toBe('unauthenticated');
    const readOnly = { key: await seedServiceKey(a.productEnvId, ['storage:read']) };
    const writeOnly = { key: await seedServiceKey(a.productEnvId, ['storage:write']) };
    const logsOnly = { key: await seedServiceKey(a.productEnvId, ['logs:write']) };
    expect(await errCode(await createUpload(readOnly))).toBe('forbidden');
    expect((await call('/v1/storage/objects?bucket=files', readOnly)).status).toBe(200);
    expect(await errCode(await call('/v1/storage/objects?bucket=files', writeOnly))).toBe('forbidden');
    expect((await createUpload(writeOnly)).status).toBe(201);
    expect(await errCode(await call('/v1/storage/objects?bucket=files', logsOnly))).toBe('forbidden');
    const id = await availableObject({ key: skA });
    expect(await errCode(await call(`/v1/storage/objects/${id}`, { ...readOnly, method: 'DELETE' }))).toBe('forbidden');
  });
});

describe('ownership inside a product', () => {
  it("hides one user's objects from another user of the same product", async () => {
    const id = await availableObject(asUserA());
    const other = { key: a.publishableKey, token: ua2.token };
    expect(await errCode(await call('/v1/storage/downloads', { ...other, body: { object_id: id } }))).toBe('not_found');
    expect(await errCode(await call(`/v1/storage/objects/${id}`, { ...other, method: 'DELETE' }))).toBe('not_found');
    expect(await errCode(await complete(other, id))).toBe('not_found');
    const listed = (await (await call('/v1/storage/objects?bucket=files&limit=100', other)).json()) as { objects: { id: string }[] };
    expect(listed.objects.map((o) => o.id)).not.toContain(id);
    // still intact for the owner
    expect((await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: id } })).status).toBe(200);
  });

  it("does not let a user complete someone else's pending upload", async () => {
    const up = (await (await createUpload(asUserA())).json()) as { object_id: string };
    expect(await errCode(await complete({ key: a.publishableKey, token: ua2.token }, up.object_id))).toBe('not_found');
  });
});

describe('cross-product isolation', () => {
  it("product B's key/token cannot create uploads into A's buckets", async () => {
    // B has its own 'files' bucket, so use a bucket name that exists only in A.
    await seedBucket(a.productEnvId, 'only-in-a');
    const asB = { key: b.publishableKey, token: ub.token };
    expect(await errCode(await createUpload(asB, { bucket: 'only-in-a' }))).toBe('not_found');
    expect(await errCode(await createUpload({ key: skB }, { bucket: 'only-in-a' }))).toBe('not_found');
    // an upload into B's own 'files' lands in B's namespace, never A's
    const res = await createUpload(asB, { bucket: 'files', product_id: 'st_a', env: 'prod' });
    const id = ((await res.json()) as { object_id: string }).object_id;
    const row = await env.DB.prepare('SELECT product_env_id, object_key FROM storage_objects WHERE id = ?').bind(id).first<{ product_env_id: string; object_key: string }>();
    expect(row!.product_env_id).toBe(b.productEnvId);
    expect(row!.object_key.startsWith('st_b/prod/files/')).toBe(true);
  });

  it("product B's credentials cannot download, list, complete or delete A's objects, even knowing the id", async () => {
    const id = await availableObject(asUserA());
    const pending = ((await (await createUpload(asUserA())).json()) as { object_id: string }).object_id;
    const attackers: Who[] = [{ key: b.publishableKey, token: ub.token }, { key: skB }];
    for (const who of attackers) {
      expect(await errCode(await call('/v1/storage/downloads', { ...who, body: { object_id: id } }))).toBe('not_found');
      expect(await errCode(await call(`/v1/storage/objects/${id}`, { ...who, method: 'DELETE' }))).toBe('not_found');
      expect(await errCode(await complete(who, pending))).toBe('not_found');
      const listed = (await (await call('/v1/storage/objects?bucket=files&limit=100', who)).json()) as { objects: { id: string }[] };
      expect(listed.objects.map((o) => o.id)).not.toContain(id);
    }
    // A's object survived all of it
    expect((await call('/v1/storage/downloads', { ...asUserA(), body: { object_id: id } })).status).toBe(200);
  });

  it("A's token with B's key fails and cannot touch either product's data", async () => {
    await seedMembership(ua.userId, b.productId); // even with a membership in B, the token's audience is A
    const id = await availableObject(asUserA());
    const mixed = { key: b.publishableKey, token: ua.token };
    const res = await call('/v1/storage/downloads', { ...mixed, body: { object_id: id } });
    expect(res.status).toBe(401);
    expect(await errCode(await call('/v1/storage/objects?bucket=files', mixed))).toBe('invalid_token');
    expect(await errCode(await createUpload(mixed))).toBe('invalid_token');
    expect(await errCode(await call(`/v1/storage/objects/${id}`, { ...mixed, method: 'DELETE' }))).toBe('invalid_token');
  });

  it("an upload URL issued for A's object cannot be redirected: signed key is fixed to A's namespace", async () => {
    const up = (await (await createUpload(asUserA())).json()) as { url: string; headers: Record<string, string> };
    const [body, sig] = up.url.split('/').pop()!.split('.');
    const forged = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/'))) as { k: string };
    forged.k = forged.k.replace('st_a/', 'st_b/');
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await call(`/v1/storage/local/upload/${forgedBody}.${sig}`, { method: 'PUT', rawBody: text('hello'), headers: up.headers });
    expect(res.status).toBe(404);
  });
});
