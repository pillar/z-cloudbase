import { describe, expect, it } from 'vitest';
import {
  PUBLISHABLE_KEY_RE, SERVICE_KEY_RE, clientId, keyEnvironment, newPublishableKey,
  newServiceKey, newUserId, parseClientId, uuidv7,
} from '../src/index.ts';

describe('ids', () => {
  it('uuidv7 has version 7 and RFC variant and sorts by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(newUserId()).toMatch(/^usr_/);
  });

  it('client id round-trips and rejects malformed values', () => {
    expect(parseClientId(clientId('product_a', 'prod'))).toEqual({ productId: 'product_a', env: 'prod' });
    expect(parseClientId('product_a.qa')).toBeNull();
    expect(parseClientId('A.prod')).toBeNull();
    expect(parseClientId('platform_console')).toBeNull();
  });

  it('keys match their documented format and carry their environment', () => {
    const pk = newPublishableKey('staging');
    const sk = newServiceKey('prod');
    expect(pk).toMatch(PUBLISHABLE_KEY_RE);
    expect(sk).toMatch(SERVICE_KEY_RE);
    expect(keyEnvironment(pk)).toBe('staging');
    expect(keyEnvironment(sk)).toBe('prod');
    expect(keyEnvironment('pk_prod_short')).toBeNull();
  });
});
