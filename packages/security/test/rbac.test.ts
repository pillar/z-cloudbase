import { describe, expect, it } from 'vitest';
import { can, redact, visibleProducts, userKey, type Grant } from '../src/index.ts';

const admin: Grant = { role: 'product_admin', productId: 'product_a' };
const dev: Grant = { role: 'product_developer', productId: 'product_a' };

describe('rbac', () => {
  it('confines product roles to their own product', () => {
    expect(can([admin], 'product:write', { productId: 'product_a' })).toBe(true);
    expect(can([admin], 'product:read', { productId: 'product_b' })).toBe(false);
    expect(can([admin], 'platform:manage')).toBe(false);
  });

  it('keeps developers away from production keys', () => {
    expect(can([dev], 'keys:manage', { productId: 'product_a', env: 'dev' })).toBe(true);
    expect(can([dev], 'keys:manage', { productId: 'product_a', env: 'prod' })).toBe(false);
    expect(can([dev], 'keys:manage', { productId: 'product_a' })).toBe(false);
    expect(can([dev], 'users:manage', { productId: 'product_a' })).toBe(false);
  });

  it('operators are read-only and cannot manage users', () => {
    const op: Grant = { role: 'operator', productId: null };
    expect(can([op], 'logs:read', { productId: 'product_b' })).toBe(true);
    expect(can([op], 'users:manage', { productId: 'product_b' })).toBe(false);
    expect(visibleProducts([op])).toBe('all');
    expect(visibleProducts([admin, dev])).toEqual(['product_a']);
  });
});

describe('redact', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(redact({ a: 1, password: 'x', nested: { Authorization: 'y', list: [{ api_key: 'z' }] } })).toEqual({
      a: 1, password: '[REDACTED]', nested: { Authorization: '[REDACTED]', list: [{ api_key: '[REDACTED]' }] },
    });
  });
});

describe('userKey', () => {
  it('is stable per salt and differs across products', async () => {
    expect(await userKey('usr_1', 's1')).toBe(await userKey('usr_1', 's1'));
    expect(await userKey('usr_1', 's1')).not.toBe(await userKey('usr_1', 's2'));
  });
});
