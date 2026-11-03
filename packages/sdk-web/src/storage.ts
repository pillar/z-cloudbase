import type {
  CompleteUploadResponse, CreateUploadRequest, CreateUploadResponse, DownloadResponse, ListObjectsResponse, StorageObject,
} from '@z-cloudbase/contracts';
import { DEFAULT_RETRY_BASE_MS, validateConfig, type ClientConfig } from './config.ts';
import { PlatformError } from './errors.ts';
import { createHttp, fetchWithTimeout, withRetry } from './http.ts';
import type { Auth } from './auth.ts';

export type { ListObjectsResponse };

export interface CreateUploadParams {
  bucket: string;
  /** A `File` or any `Blob`. */
  file: Blob;
  /** Defaults to `file.name`. */
  filename?: string;
  /** Defaults to `file.type`. */
  contentType?: string;
  /** Timeout for the byte transfer, default 10 minutes. */
  uploadTimeoutMs?: number;
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const API_RETRIES = 2;

export function createStorage(config: ClientConfig, auth: Pick<Auth, 'getAccessToken'>) {
  validateConfig(config);
  const http = createHttp(config, auth.getAccessToken);
  const f: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const complete = (objectId: string) =>
    http<CompleteUploadResponse>(`/storage/uploads/${encodeURIComponent(objectId)}/complete`, {
      method: 'POST', auth: 'required', retries: API_RETRIES,
    });

  return {
    /** create → PUT bytes to the presigned URL → complete. Resolves with the available object. */
    async createUpload(p: CreateUploadParams): Promise<StorageObject> {
      const filename = p.filename ?? (p.file as File).name;
      const contentType = p.contentType ?? p.file.type;
      if (!filename || !contentType) throw new PlatformError('sdk_error', 'filename and contentType are required');
      const req: CreateUploadRequest = { bucket: p.bucket, filename, content_type: contentType, size: p.file.size };
      const target = await http<CreateUploadResponse>('/storage/uploads', {
        method: 'POST',
        body: req,
        auth: 'required',
        // One key per logical upload: a retried create must not allocate a second object.
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        retries: API_RETRIES,
      });

      // Presigned URL: send only the headers it was signed with, never our key or bearer token.
      const url = new URL(target.url, config.endpoint).toString();
      await withRetry(async () => {
        const res = await fetchWithTimeout(f, url, {
          method: target.method, headers: target.headers, body: p.file,
        }, p.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS);
        if (!res.ok) {
          throw new PlatformError('upload_failed', `Upload failed (HTTP ${res.status})`, {
            status: res.status, retryable: res.status >= 500,
          });
        }
      }, API_RETRIES, retryBaseMs);

      return complete(target.object_id);
    },

    completeUpload: complete,

    getDownloadUrl(objectId: string, opts: { ttlSeconds?: number } = {}): Promise<DownloadResponse> {
      return http<DownloadResponse>('/storage/downloads', {
        method: 'POST',
        body: { object_id: objectId, ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}) },
        auth: 'required',
        retries: API_RETRIES,
      });
    },

    list(p: { bucket: string; cursor?: string; limit?: number }): Promise<ListObjectsResponse> {
      return http<ListObjectsResponse>('/storage/objects', {
        query: { bucket: p.bucket, cursor: p.cursor, limit: p.limit },
        auth: 'required',
        retries: API_RETRIES,
      });
    },

    async delete(objectId: string): Promise<void> {
      await http<void>(`/storage/objects/${encodeURIComponent(objectId)}`, {
        method: 'DELETE', auth: 'required', retries: API_RETRIES,
      });
    },
  };
}
