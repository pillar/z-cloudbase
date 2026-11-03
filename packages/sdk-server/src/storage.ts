import type { CompleteUploadResponse, CreateUploadRequest, CreateUploadResponse, DownloadResponse, StorageObject } from '@z-cloudbase/contracts';
import { PlatformError } from './errors.ts';
import {
  DEFAULT_RETRY_BASE_MS, fetchWithTimeout, resolveFetch, withRetry, type ServerClientConfig, type Http,
} from './http.ts';

export interface CreateUploadParams {
  bucket: string;
  filename: string;
  contentType: string;
  body: Blob | ArrayBuffer | Uint8Array;
  /** Timeout for the byte transfer, default 10 minutes. */
  uploadTimeoutMs?: number;
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const API_RETRIES = 2;

export function createStorage(http: Http, config: ServerClientConfig) {
  const f = resolveFetch(config);
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  return {
    /** create → PUT bytes to the presigned URL → complete. Resolves with the available object. */
    async createUpload(p: CreateUploadParams): Promise<StorageObject> {
      const body = p.body instanceof Blob ? p.body : new Blob([p.body as BlobPart]);
      const req: CreateUploadRequest = {
        bucket: p.bucket, filename: p.filename, content_type: p.contentType, size: body.size,
      };
      const target = await http<CreateUploadResponse>('/storage/uploads', {
        method: 'POST',
        body: req,
        // One key per logical upload: a retried create must not allocate a second object.
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        retries: API_RETRIES,
      });

      // Presigned URL: send only the headers it was signed with, never the service key.
      const url = new URL(target.url, config.endpoint).toString();
      await withRetry(async () => {
        const res = await fetchWithTimeout(f, url, {
          method: target.method, headers: target.headers, body,
        }, p.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS);
        if (!res.ok) {
          throw new PlatformError('upload_failed', `Upload failed (HTTP ${res.status})`, {
            status: res.status, retryable: res.status >= 500,
          });
        }
      }, API_RETRIES, retryBaseMs);

      return http<CompleteUploadResponse>(`/storage/uploads/${encodeURIComponent(target.object_id)}/complete`, {
        method: 'POST', retries: API_RETRIES,
      });
    },

    getDownloadUrl(objectId: string, opts: { ttlSeconds?: number } = {}): Promise<DownloadResponse> {
      return http<DownloadResponse>('/storage/downloads', {
        method: 'POST',
        body: { object_id: objectId, ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}) },
        retries: API_RETRIES,
      });
    },
  };
}
