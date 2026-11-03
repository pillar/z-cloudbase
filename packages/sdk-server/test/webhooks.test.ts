// verifyWebhook (PRD §21.6) and the impersonation `act` claim on verified tokens (PRD §21.5.2).
import { signWebhook } from '@z-cloudbase/security';
import { describe, expect, it } from 'vitest';
import { createServerClient, verifyWebhook } from '../src/index.ts';
import { ENDPOINT, baseConfig, createFakeIdp, fakeFetch, json } from './helpers.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

async function signed(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': await signWebhook(secret, 'msg_1', ts, body) };
}

describe('verifyWebhook', () => {
  const body = JSON.stringify({ id: 'msg_1', type: 'user.deleted', timestamp: new Date().toISOString(), product_id: 'product_a', env: 'prod', data: { user_id: 'usr_1', scope: 'account' } });

  it('returns the event for a valid signature (Headers or Node-style header objects)', async () => {
    const h = await signed(body);
    expect(await verifyWebhook({ secret: SECRET, headers: new Headers(h), body })).toMatchObject({ type: 'user.deleted', data: { user_id: 'usr_1' } });
    expect((await verifyWebhook({ secret: SECRET, headers: { ...h, 'Webhook-Id': h['webhook-id'] }, body })).id).toBe('msg_1');
  });

  it('rejects tampered bodies, wrong secrets and stale timestamps with invalid_signature', async () => {
    const h = await signed(body);
    await expect(verifyWebhook({ secret: SECRET, headers: h, body: body.replace('usr_1', 'usr_2') })).rejects.toMatchObject({ code: 'invalid_signature', status: 401 });
    await expect(verifyWebhook({ secret: 'whsec_' + btoa('another secret, 32 bytes long!!'), headers: h, body })).rejects.toMatchObject({ code: 'invalid_signature' });
    const old = await signed(body, Math.floor(Date.now() / 1000) - 600);
    await expect(verifyWebhook({ secret: SECRET, headers: old, body })).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifyWebhook({ secret: 'not base64 !', headers: h, body })).rejects.toMatchObject({ code: 'invalid_signature' });
  });
});

describe('impersonated tokens', () => {
  it('verifyToken returns the act claim so a product can refuse support sessions', async () => {
    const idp = await createFakeIdp();
    const api = fakeFetch((r) => (r.url.startsWith(ENDPOINT) ? json({}) : idp.handler(r)));
    const server = createServerClient(baseConfig({ fetch: api.fetch }));
    const token = await idp.minter.mint({ productId: 'product_a', env: 'dev', userId: 'usr_alice', act: { sub: 'usr_owner' } });
    const claims = await server.auth.verifyToken(token, { productId: 'product_a', env: 'dev' });
    expect(claims.act).toEqual({ sub: 'usr_owner' });
    const plain = await server.auth.verifyToken(await idp.minter.mint({ productId: 'product_a', env: 'dev' }), { productId: 'product_a', env: 'dev' });
    expect(plain.act).toBeUndefined();
  });
});
