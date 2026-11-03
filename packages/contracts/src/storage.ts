import { z } from 'zod';

export const BUCKET_NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;

export const CreateUploadRequest = z.object({
  bucket: z.string().regex(BUCKET_NAME_RE),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  size: z.number().int().positive(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const CreateUploadResponse = z.object({
  object_id: z.string(),
  method: z.literal('PUT'),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expires_at: z.string(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const OBJECT_STATUSES = ['pending', 'available', 'deleted'] as const;

export const StorageObject = z.object({
  id: z.string(),
  bucket: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size: z.number().int(),
  status: z.enum(OBJECT_STATUSES),
  created_at: z.string(),
});
export type StorageObject = z.infer<typeof StorageObject>;

/** `POST /v1/storage/uploads/:id/complete` answers with the available object. */
export const CompleteUploadResponse = StorageObject;
export type CompleteUploadResponse = StorageObject;

export const DownloadRequest = z.object({
  object_id: z.string(),
  ttl_seconds: z.number().int().positive().optional(),
});

export const DownloadResponse = z.object({ url: z.string(), expires_at: z.string() });
export type DownloadResponse = z.infer<typeof DownloadResponse>;

/** `GET /v1/storage/objects`; `next_cursor` is null on the last page. */
export const ListObjectsResponse = z.object({
  objects: z.array(StorageObject),
  next_cursor: z.string().nullable(),
});
export type ListObjectsResponse = z.infer<typeof ListObjectsResponse>;

export const ListObjectsQuery = z.object({
  bucket: z.string().regex(BUCKET_NAME_RE),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
