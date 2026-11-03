import { describe, expect, it } from 'vitest';
import { createTestTokenMinter, TEST_ISSUER } from '@z-cloudbase/testing';
import { ApiError, productAudience } from '@z-cloudbase/contracts';
import { bearerToken, verifyAccessToken } from '../src/index.ts';

const opts = (jwks: any, clientId = 'product_a.prod') => ({ issuer: TEST_ISSUER, audience: productAudience(clientId), jwks });

async function rejection(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof ApiError ? e.code : 'non-api-error'; }
  return 'accepted';
}

describe('verifyAccessToken', () => {
  it('accepts a token for its own product audience', async () => {
    const m = await createTestTokenMinter();
    const t = await m.mint({ productId: 'product_a', env: 'prod', userId: 'usr_1' });
    const claims = await verifyAccessToken(t, opts(m.jwks));
    expect(claims.sub).toBe('usr_1');
    expect(claims.pid).toBe('product_a');
  });

  it("rejects product A's token at product B (PRD §4.2)", async () => {
    const m = await createTestTokenMinter();
    const t = await m.mint({ productId: 'product_a', env: 'prod' });
    expect(await rejection(verifyAccessToken(t, opts(m.jwks, 'product_b.prod')))).toBe('invalid_token');
  });

  it('rejects the same product in another environment', async () => {
    const m = await createTestTokenMinter();
    const t = await m.mint({ productId: 'product_a', env: 'dev' });
    expect(await rejection(verifyAccessToken(t, opts(m.jwks)))).toBe('invalid_token');
  });

  it('rejects expired, wrong-issuer, foreign-key and pid/aud-mismatched tokens', async () => {
    const m = await createTestTokenMinter();
    const other = await createTestTokenMinter();
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await rejection(verifyAccessToken(await m.mint({ productId: 'product_a', env: 'prod', iat: past - 900, exp: past }), opts(m.jwks)))).toBe('token_expired');
    expect(await rejection(verifyAccessToken(await m.mint({ productId: 'product_a', env: 'prod', iss: 'http://evil' }), opts(m.jwks)))).toBe('invalid_token');
    expect(await rejection(verifyAccessToken(await other.mint({ productId: 'product_a', env: 'prod' }), opts(m.jwks)))).toBe('invalid_token');
    expect(await rejection(verifyAccessToken(await m.mint({ productId: 'product_a', env: 'prod', pid: 'product_b' }), opts(m.jwks)))).toBe('invalid_token');
  });

  it('rejects a token that also names another product in aud', async () => {
    const m = await createTestTokenMinter();
    const t = await m.mint({ productId: 'product_a', env: 'prod', aud: [productAudience('product_a.prod'), productAudience('product_b.prod')] });
    expect(await rejection(verifyAccessToken(t, opts(m.jwks)))).toBe('invalid_token');
  });

  it('rejects the bare client_id as audience (only the URN form is valid)', async () => {
    const m = await createTestTokenMinter();
    const t = await m.mint({ productId: 'product_a', env: 'prod', aud: 'product_a.prod' });
    expect(await rejection(verifyAccessToken(t, opts(m.jwks)))).toBe('invalid_token');
  });
});

describe('bearerToken', () => {
  it('parses only well-formed bearer headers', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('verifyConsoleToken', () => {
  it('accepts console tokens and keeps product and console tokens apart', async () => {
    const { verifyConsoleToken } = await import('../src/index.ts');
    const m = await createTestTokenMinter();
    const consoleToken = await m.mintConsole({ userId: 'usr_admin' });
    expect((await verifyConsoleToken(consoleToken, { issuer: TEST_ISSUER, jwks: m.jwks })).sub).toBe('usr_admin');
    const productToken = await m.mint({ productId: 'product_a', env: 'prod' });
    expect(await rejection(verifyConsoleToken(productToken, { issuer: TEST_ISSUER, jwks: m.jwks }))).toBe('invalid_token');
    expect(await rejection(verifyAccessToken(consoleToken, opts(m.jwks)))).toBe('invalid_token');
  });

  it('refuses console tokens carrying an impersonation actor (PRD §21.5.2)', async () => {
    const { verifyConsoleToken } = await import('../src/index.ts');
    const m = await createTestTokenMinter();
    const token = await m.mintConsole({ userId: 'usr_target', act: { sub: 'usr_owner' } });
    expect(await rejection(verifyConsoleToken(token, { issuer: TEST_ISSUER, jwks: m.jwks }))).toBe('invalid_token');
  });
});
