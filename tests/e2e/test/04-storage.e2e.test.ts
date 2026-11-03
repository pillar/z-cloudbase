// PRD §15 item 9: private upload (local signer) → complete → owner download with the Web SDK;
// B's user (and another A user) cannot read it; expired URLs are refused; deletion is audited;
// uploads left pending are reclaimed by the consumer cron (stack-level, scheduled handler).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  admin, api, createBucket, createProduct, createWebApp, errorOf, newUser, ownerToken as ownerConsoleToken, poll, stack, uniqueProductId,
  type WebApp,
} from '../src/world.ts';
import { d1, r2Keys, triggerCron } from '../local-stack/stack.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;
let b: Awaited<ReturnType<typeof createProduct>>;
let appA: WebApp;
let appB: WebApp;
let other: WebApp;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  a = await createProduct(ownerToken, uniqueProductId('st'));
  b = await createProduct(ownerToken, uniqueProductId('su'));
  await createBucket(ownerToken, a.prod, 'avatars');
  await createBucket(ownerToken, b.prod, 'avatars');
  const u = await newUser('storage');
  appA = createWebApp(u.browser, a.prod);
  await appA.signIn();
  appB = createWebApp(u.browser, b.prod); // the same person in product B
  await appB.signIn();
  const v = await newUser('storage-other');
  other = createWebApp(v.browser, a.prod);
  await other.signIn();
});

async function download(url: string) {
  return fetch(url);
}

describe('§15-9 private storage', () => {
  let objectId: string;

  it('uploads through the signed local URL, completes and downloads the same bytes as the owner', async () => {
    appA.tab.activate();
    const obj = await appA.sdk.storage.createUpload({ bucket: 'avatars', file: new Blob([PNG], { type: 'image/png' }), filename: 'me.png' });
    expect(obj).toMatchObject({ bucket: 'avatars', filename: 'me.png', content_type: 'image/png', size: PNG.byteLength, status: 'available' });
    objectId = obj.id;
    const list = await appA.sdk.storage.list({ bucket: 'avatars' });
    expect(list).toEqual({ objects: [obj], next_cursor: null });

    const { url, expires_at } = await appA.sdk.storage.getDownloadUrl(objectId);
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    const res = await download(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // Stored under the product / env / bucket / owner prefix.
    const keys = await r2Keys(stack(), 'cloudbase-storage', `${a.productId}/prod/avatars/`);
    expect(keys.some((k) => k.endsWith(objectId))).toBe(true);
  });

  it("is invisible to the same person in product B and to another user of A (404, no existence leak)", async () => {
    appB.tab.activate();
    await expect(appB.sdk.storage.getDownloadUrl(objectId)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect((await appB.sdk.storage.list({ bucket: 'avatars' })).objects).toEqual([]);
    other.tab.activate();
    await expect(other.sdk.storage.getDownloadUrl(objectId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await other.sdk.storage.list({ bucket: 'avatars' })).objects).toEqual([]);
    // A's token with B's key: rejected before any lookup.
    appA.tab.activate();
    const tokenA = (await appA.sdk.auth.getAccessToken())!;
    const res = await api('/v1/storage/downloads', { key: b.prod.publishableKey, token: tokenA, body: { object_id: objectId } });
    expect(res.status).toBe(401);
  });

  it('refuses an expired download URL and a tampered one', async () => {
    appA.tab.activate();
    const { url } = await appA.sdk.storage.getDownloadUrl(objectId, { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    const expired = await download(url);
    expect(expired.status).toBe(404);
    const tampered = await download(`${url.slice(0, -2)}xx`);
    expect(tampered.status).toBe(404);
  });

  it('deletes the object (R2 + row) and records it in the product audit trail', async () => {
    appA.tab.activate();
    await appA.sdk.storage.delete(objectId);
    await expect(appA.sdk.storage.getDownloadUrl(objectId)).rejects.toMatchObject({ code: 'not_found' });
    const keys = await r2Keys(stack(), 'cloudbase-storage', `${a.productId}/prod/avatars/`);
    expect(keys.some((k) => k.endsWith(objectId))).toBe(false);
    const audit = await admin<{ entries: Array<{ action: string; target_id: string; actor_type: string }> }>(ownerToken, 'GET', `/audit?product_id=${a.productId}`);
    expect(audit.body.entries).toContainEqual(expect.objectContaining({ action: 'storage.object.delete', target_id: objectId, actor_type: 'user' }));
  });

  it('rejects an upload whose bytes do not match the declared image type', async () => {
    appA.tab.activate();
    await expect(appA.sdk.storage.createUpload({ bucket: 'avatars', file: new Blob(['not a png'], { type: 'image/png' }), filename: 'x.png' }))
      .rejects.toMatchObject({ code: 'unsupported_type' });
  });
});

describe('stale pending uploads (consumer cron)', () => {
  it('reclaims an upload that was never completed once it is older than the URL TTL + 1h', async () => {
    appA.tab.activate();
    const token = (await appA.sdk.auth.getAccessToken())!;
    const created = await api('/v1/storage/uploads', {
      key: a.prod.publishableKey, token, body: { bucket: 'avatars', filename: 'half.png', content_type: 'image/png', size: PNG.byteLength },
    });
    expect(created.status).toBe(201);
    const target = (await created.json()) as { object_id: string; url: string; headers: Record<string, string> };
    expect((await fetch(target.url, { method: 'PUT', headers: target.headers, body: PNG })).status).toBe(200); // bytes, but no complete
    // Age the row past the threshold (the only way to fast-forward time against a live stack).
    await d1(stack(), 'platform', 'UPDATE storage_objects SET created_at = ? WHERE id = ?', [Date.now() - 2 * 3600_000, target.object_id]);

    await triggerCron(stack(), '*/15 * * * *');

    await poll('pending row reaped', async () =>
      (await d1(stack(), 'platform', 'SELECT id FROM storage_objects WHERE id = ?', [target.object_id])).length === 0);
    const keys = await r2Keys(stack(), 'cloudbase-storage', `${a.productId}/prod/avatars/`);
    expect(keys.some((k) => k.endsWith(target.object_id))).toBe(false);
    const audit = await admin<{ entries: Array<{ action: string; target_id: string; actor_type: string }> }>(ownerToken, 'GET', `/audit?product_id=${a.productId}`);
    expect(audit.body.entries).toContainEqual(expect.objectContaining({ action: 'storage.pending_upload.reaped', target_id: target.object_id, actor_type: 'system' }));
    // Completing it now fails cleanly.
    const late = await api(`/v1/storage/uploads/${target.object_id}/complete`, { key: a.prod.publishableKey, token, method: 'POST' });
    expect((await errorOf(late)).code).toBe('not_found');
  });
});
