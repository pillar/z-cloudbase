// Response shapes of /v1/admin (services/api/src/routes/admin). Request bodies are validated server-side
// against the contracts schemas, so only responses are typed here.
import type { Environment } from '@z-cloudbase/contracts';

export interface Grant {
  role: 'owner' | 'operator' | 'product_admin' | 'product_developer';
  productId: string | null;
}
export interface Me {
  user_id: string;
  grants: Grant[];
}

export interface ProductSummary {
  id: string;
  name: string;
  status: 'active' | 'disabled' | 'archived';
  visibility: 'open' | 'restricted';
  created_at: number;
  updated_at: number;
}
export interface EnvironmentInfo {
  id: string;
  env: Environment;
  publishable_key: string;
  storage_quota_bytes: number;
  max_object_bytes: number;
  allowed_mime_types: string[];
  allowed_extensions: string[];
  daily_upload_quota_bytes: number;
  unknown_event_policy: string;
}
export interface ProductDetail extends ProductSummary {
  redirect_uris: string[];
  allowed_origins: string[];
  environments: EnvironmentInfo[];
}

export interface ServiceKey {
  id: string;
  env: Environment;
  label: string | null;
  scopes: string[];
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export interface CreatedServiceKey extends Omit<ServiceKey, 'created_by' | 'last_used_at' | 'revoked_at'> {
  /** Plaintext secret; returned exactly once. */
  key: string;
}

export interface Bucket {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  created_at: number;
}
export interface EventSchema {
  id: string;
  event_name: string;
  schema_version: number;
  /** EventPropertySchema (contracts). */
  schema: unknown;
  created_at: number;
}

export interface UsageResponse {
  estimate: true;
  usage: Array<{
    env: Environment;
    storage: { bytes: number; objects: number; quota_bytes: number };
    events: { total: number; source: string; window_days: number } | null;
  }>;
}
export interface AnalyticsSummary {
  daily: Array<{ day: string; users: number; anonymous: number; events: number }>;
  events_total: number;
  top_events: Array<{ name: string; count: number }>;
  source: 'analytics_engine' | 'd1_substitute';
}
export interface LogRecord {
  received_at: string;
  source: 'server' | 'browser';
  ingest_request_id: string;
  entry: { level: string; timestamp: string; message: string; request_id?: string; event_name?: string; attributes?: Record<string, unknown> };
}

export interface MembershipRow {
  user_id: string;
  status: 'active' | 'suspended' | 'revoked';
  joined_at: number;
  last_seen_at: number | null;
}
export interface UserLookup {
  user: { id: string; name: string; email: string; email_verified: boolean; is_anonymous: boolean; created_at: string | number; deleted_at: string | number | null };
  memberships: Array<{ product_id: string; product_name: string; status: MembershipRow['status']; joined_at: number; last_seen_at: number | null }>;
  deletion_requests: Array<{ id: string; kind: string; scope: string; product_id: string | null; status: string; requested_at: number; due_at: number; completed_at: number | null }>;
}

export interface TeamMember {
  id: string;
  user_id: string;
  role: Grant['role'];
  product_id: string | null;
  created_by: string | null;
  created_at: number;
}
export interface AuditEntry {
  id: string;
  occurred_at: number;
  actor_id: string;
  action: string;
  product_id: string | null;
  env: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}
