import { z } from 'zod';
import { ENVIRONMENTS, PRODUCT_ID_RE } from './ids.ts';

export const PRODUCT_VISIBILITIES = ['open', 'restricted'] as const;
export const PRODUCT_STATUSES = ['active', 'disabled', 'archived'] as const;
export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'revoked'] as const;

export const CreateProductRequest = z.object({
  product_id: z.string().regex(PRODUCT_ID_RE),
  name: z.string().min(1).max(100),
  visibility: z.enum(PRODUCT_VISIBILITIES).default('open'),
  redirect_uris: z.array(z.url()).max(20).default([]),
  allowed_origins: z.array(z.url()).max(20).default([]),
});
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

export const UpdateProductRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  visibility: z.enum(PRODUCT_VISIBILITIES).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  redirect_uris: z.array(z.url()).max(20).optional(),
  allowed_origins: z.array(z.url()).max(20).optional(),
});

export const SERVICE_SCOPES = [
  'storage:read',
  'storage:write',
  'logs:write',
  'events:write',
  'users:read',
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export const CreateServiceKeyRequest = z.object({
  env: z.enum(ENVIRONMENTS),
  scopes: z.array(z.enum(SERVICE_SCOPES)).min(1),
  label: z.string().max(100).optional(),
});

export const ROLES = ['owner', 'operator', 'product_admin', 'product_developer'] as const;
export type Role = (typeof ROLES)[number];

export const AddTeamMemberRequest = z.object({
  user_id: z.string().startsWith('usr_'),
  role: z.enum(ROLES),
  product_id: z.string().regex(PRODUCT_ID_RE).optional(),
});

export const UNKNOWN_EVENT_POLICIES = ['accept', 'reject'] as const;

/** File extension without dot, lowercase. */
export const FILE_EXTENSION_RE = /^[a-z0-9]{1,16}$/;

/** Per-environment storage / ingestion settings (PATCH /v1/admin/products/:id/environments/:env). */
export const UpdateEnvironmentRequest = z.object({
  storage_quota_bytes: z.number().int().positive().optional(),
  max_object_bytes: z.number().int().positive().optional(),
  /** Empty = any MIME type. */
  allowed_mime_types: z.array(z.string().min(1).max(255)).max(100).optional(),
  /** Empty = any extension. Checked against the filename's last extension. */
  allowed_extensions: z.array(z.string().regex(FILE_EXTENSION_RE)).max(100).optional(),
  daily_upload_quota_bytes: z.number().int().positive().optional(),
  unknown_event_policy: z.enum(UNKNOWN_EVENT_POLICIES).optional(),
});
export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequest>;
