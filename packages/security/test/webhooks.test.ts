import { describe, expect, it } from 'vitest';
import {
  WebhookVerificationError, can, checkWebhookUrl, newWebhookSecret, signWebhook, verifyWebhookSignature, webhookHeaders, type Grant,
} from '../src/index.ts';

// Published Standard Webhooks test vector (the reference libraries' signature test).
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('Standard Webhooks signatures', () => {
  it('matches the reference test vector', async () => {
    expect(await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
  });

  it('verifies the vector within the tolerance and rejects tampering, replays and wrong secrets', async () => {
    const headers = { 'webhook-id': VECTOR.id, 'webhook-timestamp': String(VECTOR.timestamp), 'webhook-signature': VECTOR.signature };
    const now = VECTOR.timestamp * 1000 + 60_000;
    await expect(verifyWebhookSignature({ secret: VECTOR.secret, headers, body: VECTOR.body, now })).resolves.toEqual({ id: VECTOR.id, timestamp: VECTOR.timestamp });
    await expect(verifyWebhookSignature({ secret: VECTOR.secret, headers, body: VECTOR.body + ' ', now })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhookSignature({ secret: VECTOR.secret, headers, body: VECTOR.body, now: now + 10 * 60_000 })).rejects.toThrow(/tolerance/);
    await expect(verifyWebhookSignature({ secret: newWebhookSecret(), headers, body: VECTOR.body, now })).rejects.toThrow(/signature/);
    await expect(verifyWebhookSignature({ secret: VECTOR.secret, headers: { ...headers, 'webhook-id': 'msg_other' }, body: VECTOR.body, now })).rejects.toThrow();
    await expect(verifyWebhookSignature({ secret: VECTOR.secret, headers: {}, body: VECTOR.body, now })).rejects.toThrow(/Missing/);
  });

  it('signs with every secret during a rotation; either one verifies', async () => {
    const [oldSecret, newSecret] = [newWebhookSecret(), newWebhookSecret()];
    expect(newSecret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const ts = Math.floor(Date.now() / 1000);
    const h = new Headers(await webhookHeaders([newSecret, oldSecret], 'msg_1', ts, '{}'));
    expect(h.get('webhook-signature')!.split(' ')).toHaveLength(2);
    await expect(verifyWebhookSignature({ secret: oldSecret, headers: h, body: '{}' })).resolves.toMatchObject({ id: 'msg_1' });
    await expect(verifyWebhookSignature({ secret: newSecret, headers: h, body: '{}' })).resolves.toMatchObject({ id: 'msg_1' });
  });
});

describe('webhook URL rules (SSRF guard)', () => {
  it('requires https outside dev and allows http://localhost only in dev', () => {
    expect(checkWebhookUrl('https://hooks.example.com/z', 'prod')).toBeNull();
    expect(checkWebhookUrl('http://hooks.example.com/z', 'prod')).toBe('https_required');
    expect(checkWebhookUrl('http://hooks.example.com/z', 'dev')).toBe('https_required');
    expect(checkWebhookUrl('http://localhost:9000/hook', 'dev')).toBeNull();
    expect(checkWebhookUrl('http://127.0.0.1:9000/hook', 'dev')).toBeNull();
    expect(checkWebhookUrl('http://[::1]:9000/hook', 'dev')).toBeNull();
    expect(checkWebhookUrl('http://localhost:9000/hook', 'staging')).toBe('https_required');
    expect(checkWebhookUrl('https://localhost/hook', 'prod')).toBe('localhost_not_allowed');
    expect(checkWebhookUrl('https://LOCALHOST./hook', 'prod')).toBe('localhost_not_allowed');
    expect(checkWebhookUrl('https://api.localhost/hook', 'staging')).toBe('localhost_not_allowed');
    expect(checkWebhookUrl('ftp://example.com/', 'prod')).toBe('invalid_url');
    expect(checkWebhookUrl('not a url', 'prod')).toBe('invalid_url');
    expect(checkWebhookUrl('https://user:pw@example.com/', 'prod')).toBe('credentials_not_allowed');
  });

  it('refuses private, loopback, link-local and other non-public IP literals, in every numeric spelling', () => {
    for (const host of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '2130706433', '0x7f.1', '127.1', '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]',
      '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[ff02::1]', '[64:ff9b::a00:1]',
      // Tunnels that embed an IPv4 address (6to4, its relay anycast, Teredo): refused outright.
      '[2002:7f00:1::1]', '[2002:808:808::1]', '192.88.99.1', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]', '[2001::1]',
    ]) {
      expect(checkWebhookUrl(`https://${host}/hook`, 'prod'), host).toBe('private_address');
    }
    // dev only relaxes the loopback names, not private networks.
    expect(checkWebhookUrl('http://10.0.0.1/hook', 'dev')).toBe('https_required');
    expect(checkWebhookUrl('https://10.0.0.1/hook', 'dev')).toBe('private_address');
    for (const host of ['8.8.8.8', '172.32.0.1', '[2606:4700::1111]', '[::ffff:8.8.8.8]', '[2001:4860:4860::8888]', '192.88.100.1']) {
      expect(checkWebhookUrl(`https://${host}/hook`, 'prod'), host).toBeNull();
    }
  });
});

describe('rbac for user management and webhooks', () => {
  const owner: Grant = { role: 'owner', productId: null };
  const op: Grant = { role: 'operator', productId: null };
  const admin: Grant = { role: 'product_admin', productId: 'product_a' };
  const dev: Grant = { role: 'product_developer', productId: 'product_a' };

  it('ban and impersonation are owner-only', () => {
    for (const action of ['users:ban', 'users:impersonate'] as const) {
      expect(can([owner], action)).toBe(true);
      expect(can([op], action)).toBe(false);
      expect(can([admin], action, { productId: 'product_a' })).toBe(false);
      expect(can([admin], action)).toBe(false);
    }
  });

  it('webhooks: operators read, product admins manage their product, developers manage non-prod only', () => {
    expect(can([op], 'webhooks:read', { productId: 'product_b', env: 'prod' })).toBe(true);
    expect(can([op], 'webhooks:manage', { productId: 'product_b', env: 'dev' })).toBe(false);
    expect(can([admin], 'webhooks:manage', { productId: 'product_a', env: 'prod' })).toBe(true);
    expect(can([admin], 'webhooks:read', { productId: 'product_b', env: 'prod' })).toBe(false);
    expect(can([dev], 'webhooks:read', { productId: 'product_a', env: 'prod' })).toBe(true);
    expect(can([dev], 'webhooks:manage', { productId: 'product_a', env: 'dev' })).toBe(true);
    expect(can([dev], 'webhooks:manage', { productId: 'product_a', env: 'prod' })).toBe(false);
  });
});
