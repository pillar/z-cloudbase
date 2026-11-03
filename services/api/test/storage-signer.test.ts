// URL signing: LocalSigner routes (local/test only) and R2PresignSigner URL shape (remote unverified).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalSigner, R2PresignSigner } from '../src/lib/storage/signer.ts';
import { call, errCode, pathOf, seedBucket } from './api-helpers.ts';
import { seedProduct, userFor, type SeededEnv } from './helpers.ts';

let p: SeededEnv;
let who: { key: string; token: string };
beforeAll(async () => {
  p = await seedProduct({ productId: 'sg_a' });
  await seedBucket(p.productEnvId, 'files');
  who = { key: p.publishableKey, token: (await userFor(p)).token };
});

const signer = () => new LocalSigner(env);
const bytes = (s: string) => new TextEncoder().encode(s);

async function newUpload(content = 'hello', content_type = 'text/plain') {
  const res = await call('/v1/storage/uploads', { ...who, body: { bucket: 'files', filename: 'f.txt', content_type, size: bytes(content).byteLength } });
  return (await res.json()) as { object_id: string; url: string; headers: Record<string, string> };
}

describe('local upload URL', () => {
  it('rejects tampered, truncated and foreign-secret tokens and stores nothing', async () => {
    const up = await newUpload();
    const [body, sig] = up.url.split('/').pop()!.split('.');
    const attempts = [
      `${body}.${sig!.slice(0, -2)}AA`,
      `${body}x.${sig}`,
      `${body}`,
      `${body}.${sig}.extra`,
      'garbage',
    ];
    for (const t of attempts) {
      const res = await call(`/v1/storage/local/upload/${t}`, { method: 'PUT', rawBody: bytes('hello'), headers: up.headers });
      expect(res.status, t).toBe(404);
    }
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string }>())!.object_key;
    expect(await env.STORAGE.head(key)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signer().token({ k: 'sg_a/prod/files/_service/x', m: 'PUT', e: Date.now() - 1000, t: 'text/plain', s: 1 });
    const res = await call(`/v1/storage/local/upload/${token}`, { method: 'PUT', rawBody: bytes('x'), headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(404);
    expect(await env.STORAGE.head('sg_a/prod/files/_service/x')).toBeNull();
  });

  it('binds the signed content type and size', async () => {
    const up = await newUpload('hello');
    const path = pathOf(up.url);
    expect(await errCode(await call(path, { method: 'PUT', rawBody: bytes('hello'), headers: { 'Content-Type': 'text/html' } }))).toBe('unsupported_type');
    expect(await errCode(await call(path, { method: 'PUT', rawBody: bytes('hello world'), headers: up.headers }))).toBe('invalid_request');
    expect((await call(path, { method: 'PUT', rawBody: bytes('hello'), headers: up.headers })).status).toBe(200);
  });

  it('does not accept a download token for upload or an upload token for download', async () => {
    const up = await newUpload();
    const asDownload = pathOf(up.url).replace('/upload/', '/download/');
    expect((await call(asDownload)).status).toBe(404);

    const id = up.object_id;
    await call(pathOf(up.url), { method: 'PUT', rawBody: bytes('hello'), headers: up.headers });
    await call(`/v1/storage/uploads/${id}/complete`, { ...who, method: 'POST' });
    const dl = (await (await call('/v1/storage/downloads', { ...who, body: { object_id: id } })).json()) as { url: string };
    const asUpload = pathOf(dl.url).replace('/download/', '/upload/');
    expect((await call(asUpload, { method: 'PUT', rawBody: bytes('hello'), headers: up.headers })).status).toBe(404);
  });
});

describe('local download URL', () => {
  it('serves the bytes as an attachment, and stops working after expiry', async () => {
    const up = await newUpload('payload');
    await call(pathOf(up.url), { method: 'PUT', rawBody: bytes('payload'), headers: up.headers });
    await call(`/v1/storage/uploads/${up.object_id}/complete`, { ...who, method: 'POST' });
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string }>())!.object_key;

    const ok = await signer().token({ k: key, m: 'GET', e: Date.now() + 60_000 });
    const res = await call(`/v1/storage/local/download/${ok}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('payload');

    const expired = await signer().token({ k: key, m: 'GET', e: Date.now() - 1 });
    expect((await call(`/v1/storage/local/download/${expired}`)).status).toBe(404);
  });
});

describe('environment gating', () => {
  it('serves the local routes only when DEPLOY_ENV is local or test', async () => {
    const up = await newUpload();
    const prodEnv = { DEPLOY_ENV: 'production' };
    const res = await call(pathOf(up.url), { method: 'PUT', rawBody: bytes('hello'), headers: up.headers, env: prodEnv });
    expect(res.status).toBe(404);
    const key = (await env.DB.prepare('SELECT object_key FROM storage_objects WHERE id = ?').bind(up.object_id).first<{ object_key: string }>())!.object_key;
    expect(await env.STORAGE.head(key)).toBeNull();
    expect((await call(pathOf(up.url), { method: 'PUT', rawBody: bytes('hello'), headers: up.headers, env: { DEPLOY_ENV: 'test' } })).status).toBe(200);
  });

  it('uses the R2 presign signer outside local/test and reports missing credentials as unavailable', async () => {
    const prodEnv = { DEPLOY_ENV: 'production' };
    const res = await call('/v1/storage/uploads', { ...who, env: prodEnv, body: { bucket: 'files', filename: 'f.txt', content_type: 'text/plain', size: 1 } });
    expect(res.status).toBe(503);
    expect(await errCode(res)).toBe('unavailable');
  });
});

// REMOTE UNVERIFIED: only checks the shape of the URL; real R2 acceptance needs a staging bucket and credentials.
describe('R2PresignSigner (shape only)', () => {
  const s = new R2PresignSigner({ ...env, R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET_NAME: 'bkt' });

  it('signs upload and download URLs against the R2 S3 endpoint with the requested expiry', async () => {
    const up = await s.signUpload({ key: 'p/prod/files/usr_1/obj_1', contentType: 'text/plain', size: 3, expiresAt: Date.now() + 600_000 });
    const u = new URL(up.url);
    expect(u.host).toBe('acct.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/bkt/p/prod/files/usr_1/obj_1');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(Number(u.searchParams.get('X-Amz-Expires'))).toBeGreaterThan(590);
    expect(up.headers['Content-Type']).toBe('text/plain');

    const dl = new URL(await s.signDownload({ key: 'p/prod/files/usr_1/obj_1', expiresAt: Date.now() + 300_000 }));
    expect(dl.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(dl.searchParams.get('response-content-disposition')).toBe('attachment');
  });
});
