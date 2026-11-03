// Form <-> request mapping for environment settings and event schemas (contracts: UpdateEnvironmentRequest, RegisterEventSchemaRequest).
import { RegisterEventSchemaRequest, UpdateEnvironmentRequest } from '@z-cloudbase/contracts';
import type { EnvironmentInfo } from './types.ts';

const MB = 1024 * 1024;

export interface EnvForm {
  storageQuotaMb: string;
  maxObjectMb: string;
  dailyUploadMb: string;
  mimeTypes: string;
  extensions: string;
  unknownEventPolicy: 'accept' | 'reject';
}

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

/** Comma / whitespace separated list -> trimmed, lowercase, de-duplicated entries. */
export const parseList = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

export const formFromEnv = (e: EnvironmentInfo): EnvForm => ({
  storageQuotaMb: String(e.storage_quota_bytes / MB),
  maxObjectMb: String(e.max_object_bytes / MB),
  dailyUploadMb: String(e.daily_upload_quota_bytes / MB),
  mimeTypes: e.allowed_mime_types.join(', '),
  extensions: e.allowed_extensions.join(', '),
  unknownEventPolicy: e.unknown_event_policy === 'reject' ? 'reject' : 'accept',
});

const issueText = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

/** Extensions may be typed as ".PNG"; the contract wants lowercase without a dot. */
export function buildEnvUpdate(f: EnvForm): Built<UpdateEnvironmentRequest> {
  const r = UpdateEnvironmentRequest.safeParse({
    storage_quota_bytes: Math.round(Number(f.storageQuotaMb) * MB),
    max_object_bytes: Math.round(Number(f.maxObjectMb) * MB),
    daily_upload_quota_bytes: Math.round(Number(f.dailyUploadMb) * MB),
    allowed_mime_types: parseList(f.mimeTypes),
    allowed_extensions: parseList(f.extensions).map((x) => x.replace(/^\./, '')),
    unknown_event_policy: f.unknownEventPolicy,
  });
  return r.success ? { ok: true, value: r.data } : { ok: false, error: issueText(r.error) };
}

export function buildEventSchemaRequest(name: string, version: string, schemaJson: string): Built<RegisterEventSchemaRequest> {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    return { ok: false, error: 'Schema is not valid JSON' };
  }
  const r = RegisterEventSchemaRequest.safeParse({ event_name: name, schema_version: Number(version), schema });
  return r.success ? { ok: true, value: r.data } : { ok: false, error: issueText(r.error) };
}

export const EXAMPLE_EVENT_SCHEMA = JSON.stringify(
  { properties: { plan: { type: 'string', required: true, enum: ['free', 'pro'] }, amount: { type: 'number', minimum: 0 } }, additional_properties: true },
  null,
  2,
);
