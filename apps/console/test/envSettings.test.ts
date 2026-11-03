import { describe, expect, it } from 'vitest';
import { EXAMPLE_EVENT_SCHEMA, buildEnvUpdate, buildEventSchemaRequest, formFromEnv, parseList } from '../src/envSettings.ts';
import type { EnvironmentInfo } from '../src/types.ts';

const env: EnvironmentInfo = {
  id: 'p.dev', env: 'dev', publishable_key: 'pk', storage_quota_bytes: 5 * 1024 ** 3, max_object_bytes: 50 * 1024 ** 2,
  allowed_mime_types: ['image/*'], allowed_extensions: ['png'], daily_upload_quota_bytes: 1024 ** 3, unknown_event_policy: 'reject',
};

describe('environment settings form', () => {
  it('parses lists with commas, spaces and newlines, lowercased and de-duplicated', () => {
    expect(parseList('PNG, jpg\n png  gif')).toEqual(['png', 'jpg', 'gif']);
    expect(parseList('  ')).toEqual([]);
  });

  it('round-trips an environment into a valid update request', () => {
    const built = buildEnvUpdate(formFromEnv(env));
    expect(built).toEqual({
      ok: true,
      value: {
        storage_quota_bytes: env.storage_quota_bytes, max_object_bytes: env.max_object_bytes, daily_upload_quota_bytes: 1024 ** 3,
        allowed_mime_types: ['image/*'], allowed_extensions: ['png'], unknown_event_policy: 'reject',
      },
    });
  });

  it('normalises typed extensions and allows empty lists (= unrestricted)', () => {
    const f = { ...formFromEnv(env), extensions: '.PNG, .Jpg', mimeTypes: '' };
    expect(buildEnvUpdate(f)).toMatchObject({ ok: true, value: { allowed_extensions: ['png', 'jpg'], allowed_mime_types: [] } });
  });

  it('reports contract violations instead of building a request', () => {
    expect(buildEnvUpdate({ ...formFromEnv(env), dailyUploadMb: '0' })).toMatchObject({ ok: false, error: expect.stringContaining('daily_upload_quota_bytes') });
    expect(buildEnvUpdate({ ...formFromEnv(env), dailyUploadMb: 'abc' }).ok).toBe(false);
    expect(buildEnvUpdate({ ...formFromEnv(env), extensions: 'tar.gz' })).toMatchObject({ ok: false, error: expect.stringContaining('allowed_extensions') });
  });
});

describe('event schema form', () => {
  it('builds a request from the example schema', () => {
    expect(buildEventSchemaRequest('upgrade', '2', EXAMPLE_EVENT_SCHEMA)).toMatchObject({
      ok: true,
      value: { event_name: 'upgrade', schema_version: 2, schema: { properties: { plan: { type: 'string', required: true } }, additional_properties: true } },
    });
  });

  it('rejects bad JSON, bad names and schemas outside the supported subset', () => {
    expect(buildEventSchemaRequest('upgrade', '1', '{')).toEqual({ ok: false, error: 'Schema is not valid JSON' });
    expect(buildEventSchemaRequest('Bad Name', '1', EXAMPLE_EVENT_SCHEMA).ok).toBe(false);
    expect(buildEventSchemaRequest('upgrade', '0', EXAMPLE_EVENT_SCHEMA).ok).toBe(false);
    expect(buildEventSchemaRequest('upgrade', '1', '{"properties":{"x":{"type":"object"}}}').ok).toBe(false);
  });
});
