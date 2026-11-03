import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRateLimitNamespaces, rateLimitNamespaceId, readJsonc } from '../lib/wrangler.ts';

test('rate limit namespace id: deterministic, numeric, distinct per prefix, never the local value', () => {
  const a = rateLimitNamespaceId('z-cloudbase');
  assert.equal(a, rateLimitNamespaceId('z-cloudbase'));
  assert.match(a, /^[1-9]\d{6,9}$/);
  assert.ok(Number(a) < 2 ** 31);
  const ids = new Set(['z-cloudbase', 'other-x', 'acme', 'acme-staging', 'prod', 'dev-1'].map(rateLimitNamespaceId));
  assert.equal(ids.size, 6);
  assert.ok(!ids.has('2001'));
});

test('generated api config gets the derived namespace; the checked-in value stays local', () => {
  const source = readJsonc<Record<string, any>>('services/api/wrangler.jsonc');
  assert.equal(source.ratelimits[0].namespace_id, '2001');
  const generated = structuredClone(source);
  applyRateLimitNamespaces(generated, 'other-x');
  assert.equal(generated.ratelimits[0].namespace_id, rateLimitNamespaceId('other-x'));
  assert.equal(generated.ratelimits[0].name, 'INGEST_LIMITER');
  assert.equal(source.ratelimits[0].namespace_id, '2001');
  const none: Record<string, any> = {};
  applyRateLimitNamespaces(none, 'x-y');
  assert.deepEqual(none, {});
});
