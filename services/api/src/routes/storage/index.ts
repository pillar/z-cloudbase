import {
  ApiError, CreateUploadRequest, DOWNLOAD_URL_TTL_DEFAULT_S, DOWNLOAD_URL_TTL_MAX_S, DownloadRequest, ListObjectsQuery,
  UPLOAD_URL_TTL_S, newId, type CreateUploadResponse, type DownloadResponse, type ListObjectsResponse, type ServiceScope, type StorageObject,
} from '@z-cloudbase/contracts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../context.ts';
import { withIdempotency } from '../../lib/idempotency.ts';
import { auditStatement } from '../../lib/audit.ts';
import { parseJson, parseWith } from '../../lib/storage/parse.ts';
import { SNIFF_BYTES, matchesImageSignature } from '../../lib/storage/sniff.ts';
import { LocalSigner, getSigner, isLocalEnv } from '../../lib/storage/signer.ts';
import { requireScope, withCredential, withUser } from '../../middleware/auth.ts';

export const storageRoutes = new Hono<AppEnv>();

/** End users (publishable key + token) or service keys holding `scope`. */
const principal = (scope: ServiceScope): MiddlewareHandler<AppEnv> => async (c, next) => {
  const cred = c.get('cred');
  return cred.kind === 'service' ? requireScope(scope)(c, next) : withUser({ required: true })(c, next);
};

// Local signed-URL endpoints: authenticated by the signed token alone, so they sit before the credential middleware.
const local = new Hono<AppEnv>();
local.use(async (c, next) => {
  if (!isLocalEnv(c.env)) throw new ApiError('not_found', 'Not found');
  await next();
});

local.put('/upload/:token', async (c) => {
  const p = await new LocalSigner(c.env).verify(c.req.param('token'), 'PUT');
  const contentType = baseType(c.req.header('Content-Type') ?? '');
  if (contentType !== p.t) throw new ApiError('unsupported_type', 'Content-Type does not match the signed upload');
  const body = await c.req.arrayBuffer();
  if (body.byteLength !== p.s) throw new ApiError('invalid_request', 'Body size does not match the signed upload');
  await c.env.STORAGE.put(p.k, body, { httpMetadata: { contentType } });
  return c.body(null, 200);
});

local.get('/download/:token', async (c) => {
  const p = await new LocalSigner(c.env).verify(c.req.param('token'), 'GET');
  const obj = await c.env.STORAGE.get(p.k);
  if (!obj) throw new ApiError('not_found', 'Not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

storageRoutes.route('/local', local);

storageRoutes.use(withCredential({ allow: ['publishable', 'service'] }));

interface ObjectRow {
  id: string;
  bucket: string;
  owner_user_id: string | null;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  status: StorageObject['status'];
  created_at: number;
}

const toObject = (r: ObjectRow): StorageObject => ({
  id: r.id, bucket: r.bucket, filename: r.filename, content_type: r.content_type, size: r.size,
  status: r.status, created_at: new Date(r.created_at).toISOString(),
});

/** `image/PNG; charset=x` -> `image/png` */
const baseType = (ct: string) => (ct.split(';')[0] ?? '').trim().toLowerCase();

const mimeAllowed = (allowed: string[], ct: string) =>
  allowed.length === 0 || allowed.some((a) => (a.endsWith('/*') ? ct.startsWith(a.slice(0, -1)) : a.toLowerCase() === ct));

/** Last extension, lowercase and without the dot; '' when the filename has none (a leading dot alone is not an extension). */
const extensionOf = (filename: string) => {
  const i = filename.lastIndexOf('.');
  return i <= 0 ? '' : filename.slice(i + 1).toLowerCase();
};

const utcDayStart = (ms: number) => ms - (ms % 86_400_000);

/** Who is acting: end users only touch their own objects, service keys any object of their product env. */
function actor(c: Context<AppEnv>) {
  const cred = c.get('cred');
  const user = c.get('user');
  return cred.kind === 'service'
    ? { type: 'service' as const, id: cred.credentialId!, owner: null, ownerFilter: null }
    : { type: 'user' as const, id: user!.userId, owner: user!.userId, ownerFilter: user!.userId };
}

/** Load an object of this product env visible to the actor; anything else is `not_found` (no existence leak). */
async function findObject(c: Context<AppEnv>, id: string, status: StorageObject['status']): Promise<ObjectRow> {
  const a = actor(c);
  const row = await c.env.DB.prepare(
    `SELECT * FROM storage_objects WHERE id = ? AND product_env_id = ? AND status = ? AND (? IS NULL OR owner_user_id = ?)`,
  ).bind(id, c.get('cred').productEnvId, status, a.ownerFilter, a.ownerFilter).first<ObjectRow>();
  if (!row) throw new ApiError('not_found', 'Object not found');
  return row;
}

storageRoutes.post('/uploads', principal('storage:write'), async (c) => {
  const raw = await c.req.text();
  return withIdempotency(c, 'POST /v1/storage/uploads', raw, async () => {
    const req = parseWith(CreateUploadRequest, parseJson(raw));
    const cred = c.get('cred');
    const a = actor(c);
    const contentType = baseType(req.content_type);

    const limits = await c.env.DB.prepare(
      `SELECT pe.storage_quota_bytes, pe.max_object_bytes, pe.allowed_mime_types, pe.allowed_extensions, pe.daily_upload_quota_bytes
       FROM product_environments pe WHERE pe.id = ? AND EXISTS (SELECT 1 FROM storage_buckets b WHERE b.product_env_id = pe.id AND b.name = ?)`,
    ).bind(cred.productEnvId, req.bucket).first<{
      storage_quota_bytes: number; max_object_bytes: number; allowed_mime_types: string; allowed_extensions: string; daily_upload_quota_bytes: number;
    }>();
    if (!limits) throw new ApiError('not_found', 'Bucket not found');

    if (req.size > limits.max_object_bytes) {
      throw new ApiError('payload_too_large', 'Object exceeds the maximum size', { max_object_bytes: limits.max_object_bytes });
    }
    if (!contentType.includes('/') || !mimeAllowed(JSON.parse(limits.allowed_mime_types) as string[], contentType)) {
      throw new ApiError('unsupported_type', 'Content type is not allowed for this product');
    }
    const extensions = JSON.parse(limits.allowed_extensions) as string[];
    if (extensions.length > 0 && !extensions.includes(extensionOf(req.filename))) {
      throw new ApiError('unsupported_type', 'File extension is not allowed for this product');
    }

    const id = newId('obj');
    const key = `${cred.productId}/${cred.env}/${req.bucket}/${a.owner ?? '_service'}/${id}`;
    const now = Date.now();
    // Quota checks and reservation in one statement so concurrent uploads cannot jointly exceed them. The daily
    // quota (PRD §19.11) counts every upload created since UTC midnight, whatever its status, so deleting does not refill it.
    const dayStart = utcDayStart(now);
    const ins = await c.env.DB.prepare(
      `INSERT INTO storage_objects (id, product_env_id, bucket, owner_user_id, object_key, filename, content_type, size, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
       WHERE (SELECT COALESCE(SUM(size), 0) FROM storage_objects WHERE product_env_id = ? AND status IN ('pending','available')) + ? <= ?
         AND (SELECT COALESCE(SUM(size), 0) FROM storage_objects WHERE product_env_id = ? AND created_at >= ?) + ? <= ?`,
    ).bind(
      id, cred.productEnvId, req.bucket, a.owner, key, req.filename, contentType, req.size, now,
      cred.productEnvId, req.size, limits.storage_quota_bytes,
      cred.productEnvId, dayStart, req.size, limits.daily_upload_quota_bytes,
    ).run();
    if (ins.meta.changes === 0) {
      const used = await c.env.DB.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM storage_objects WHERE product_env_id = ? AND status IN ('pending','available')`)
        .bind(cred.productEnvId).first<{ n: number }>();
      throw new ApiError('quota_exceeded', (used?.n ?? 0) + req.size > limits.storage_quota_bytes ? 'Storage quota exceeded' : 'Daily upload quota exceeded');
    }

    const expiresAt = now + UPLOAD_URL_TTL_S * 1000;
    const signed = await getSigner(c.env).signUpload({ key, contentType, size: req.size, expiresAt });
    return {
      status: 201,
      body: { object_id: id, method: 'PUT', url: signed.url, headers: signed.headers, expires_at: new Date(expiresAt).toISOString() } satisfies CreateUploadResponse,
    };
  });
});

storageRoutes.post('/uploads/:id/complete', principal('storage:write'), async (c) => {
  const id = c.req.param('id');
  const a = actor(c);
  const cred = c.get('cred');
  // Re-completing an available object is a harmless retry of a lost response.
  const done = await c.env.DB.prepare(
    `SELECT * FROM storage_objects WHERE id = ? AND product_env_id = ? AND status = 'available' AND (? IS NULL OR owner_user_id = ?)`,
  ).bind(id, cred.productEnvId, a.ownerFilter, a.ownerFilter).first<ObjectRow>();
  if (done) return c.json(toObject(done));

  const row = await findObject(c, id, 'pending');
  const head = await c.env.STORAGE.head(row.object_key);
  if (!head) throw new ApiError('invalid_request', 'Upload not found in storage; upload the file first');

  const reject = async (err: ApiError) => {
    await c.env.STORAGE.delete(row.object_key);
    await c.env.DB.prepare(`UPDATE storage_objects SET status = 'deleted', deleted_at = ?, deleted_by = 'system' WHERE id = ? AND status = 'pending'`)
      .bind(Date.now(), row.id).run();
    throw err;
  };
  if (head.size !== row.size) {
    return reject(new ApiError('invalid_request', 'Uploaded size does not match the declared size', { declared: row.size, actual: head.size }));
  }
  if (baseType(head.httpMetadata?.contentType ?? '') !== row.content_type) {
    return reject(new ApiError('unsupported_type', 'Uploaded content type does not match the declared type'));
  }
  if (row.content_type.startsWith('image/')) {
    const part = await c.env.STORAGE.get(row.object_key, { range: { offset: 0, length: Math.min(SNIFF_BYTES, row.size) } });
    const bytes = part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array();
    if (!matchesImageSignature(row.content_type, bytes)) {
      return reject(new ApiError('unsupported_type', 'File content does not match its declared image type'));
    }
  }

  const now = Date.now();
  const upd = await c.env.DB.prepare(`UPDATE storage_objects SET status = 'available', completed_at = ? WHERE id = ? AND status = 'pending'`).bind(now, row.id).run();
  // Lost a race with the stale-upload cleanup (consumer cron), which claims the row before deleting the bytes.
  if (upd.meta.changes === 0) throw new ApiError('not_found', 'Object not found');
  return c.json(toObject({ ...row, status: 'available' }));
});

storageRoutes.post('/downloads', principal('storage:read'), async (c) => {
  const req = parseWith(DownloadRequest, parseJson(await c.req.text()));
  const ttl = req.ttl_seconds ?? DOWNLOAD_URL_TTL_DEFAULT_S;
  if (ttl > DOWNLOAD_URL_TTL_MAX_S) {
    throw new ApiError('validation_failed', 'ttl_seconds exceeds the maximum', { max_ttl_seconds: DOWNLOAD_URL_TTL_MAX_S });
  }
  const row = await findObject(c, req.object_id, 'available');
  const expiresAt = Date.now() + ttl * 1000;
  const url = await getSigner(c.env).signDownload({ key: row.object_key, expiresAt });
  return c.json({ url, expires_at: new Date(expiresAt).toISOString() } satisfies DownloadResponse);
});

storageRoutes.get('/objects', principal('storage:read'), async (c) => {
  const q = parseWith(ListObjectsQuery, c.req.query());
  const cred = c.get('cred');
  const a = actor(c);
  const bucket = await c.env.DB.prepare('SELECT 1 AS ok FROM storage_buckets WHERE product_env_id = ? AND name = ?')
    .bind(cred.productEnvId, q.bucket).first();
  if (!bucket) throw new ApiError('not_found', 'Bucket not found');

  // Ids are UUIDv7, so id order is creation order and the last id is a stable cursor.
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM storage_objects WHERE product_env_id = ? AND bucket = ? AND status = 'available'
       AND (? IS NULL OR owner_user_id = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
  ).bind(cred.productEnvId, q.bucket, a.ownerFilter, a.ownerFilter, q.cursor ?? null, q.cursor ?? null, q.limit + 1).all<ObjectRow>();
  const page = results.slice(0, q.limit);
  return c.json({ objects: page.map(toObject), next_cursor: results.length > q.limit ? page[page.length - 1]!.id : null } satisfies ListObjectsResponse);
});

storageRoutes.delete('/objects/:id', principal('storage:write'), async (c) => {
  const row = await findObject(c, c.req.param('id'), 'available');
  const a = actor(c);
  const cred = c.get('cred');
  await c.env.STORAGE.delete(row.object_key);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE storage_objects SET status = 'deleted', deleted_at = ?, deleted_by = ? WHERE id = ? AND status = 'available'`)
      .bind(Date.now(), a.id, row.id),
    auditStatement(c.env.DB, {
      actorType: a.type, actorId: a.id, action: 'storage.object.delete', productId: cred.productId, env: cred.env,
      targetType: 'storage_object', targetId: row.id, requestId: c.get('requestId'),
      metadata: { bucket: row.bucket, size: row.size, owner_user_id: row.owner_user_id },
    }),
  ]);
  return c.body(null, 204);
});
