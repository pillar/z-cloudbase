// PRD §21.5 / §21.6 across the three workers: product webhooks delivered to a local receiver (signed per
// Standard Webhooks, verified with @z-cloudbase/server's verifyWebhook), the ban flow end to end (refresh
// token and access token stop working, sign-in refused with a message, events), and a support
// impersonation confirmed with TOTP whose product tokens carry the `act` claim.
import { createServer, type Server } from 'node:http';
import { verifyWebhook, type WebhookEvent } from '@z-cloudbase/server';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../../packages/testing/src/totp.ts';
import { freePort } from '../local-stack/stack.ts';
import { Browser } from '../src/browser.ts';
import {
  PASSWORD, admin, api, authorizeCode, consoleToken, createProduct, errorOf, ownerToken as ownerConsoleToken, poll, signUp, stack, tokenRequest,
  uniqueEmail, uniqueProductId,
} from '../src/world.ts';

let ownerToken: string;
let p: Awaited<ReturnType<typeof createProduct>>;
let receiver: Server;
let hookUrl: string;
let secret: string;
const events: WebhookEvent[] = [];
const rejected: string[] = [];

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  p = await createProduct(ownerToken, uniqueProductId('wh'));
  // The product's webhook receiver (dev environment: http://localhost is allowed there only).
  const port = await freePort();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        events.push(await verifyWebhook({ secret, headers: req.headers, body }));
        res.writeHead(204).end();
      } catch (e) {
        rejected.push(String(e));
        res.writeHead(401).end('bad signature');
      }
    });
  });
  await new Promise<void>((resolve) => receiver.listen(port, resolve));
  hookUrl = `http://localhost:${port}/hook`;
});
afterAll(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

const issuer = () => stack().issuer;
const waitEvent = (what: string, match: (e: WebhookEvent) => boolean) => poll(what, async () => events.find(match), 30_000, 200);

describe('§21.6 product webhooks', () => {
  it('rejects a localhost URL outside dev; a dev endpoint receives a signed test event', async () => {
    const prodTry = await admin(ownerToken, 'POST', `/products/${p.productId}/environments/prod/webhooks`, { url: hookUrl, event_types: ['user.joined'] });
    expect(prodTry.status).toBe(400);
    const created = await admin<{ id: string; secret: string }>(ownerToken, 'POST', `/products/${p.productId}/environments/dev/webhooks`, {
      url: hookUrl, event_types: ['user.joined', 'user.banned', 'user.unbanned', 'user.deleted', 'user.upgraded'],
    });
    expect(created.status).toBe(201);
    secret = created.body.secret;
    const test = await admin<{ attempt: { status_code: number } }>(ownerToken, 'POST', `/products/${p.productId}/environments/dev/webhooks/${created.body.id}/test`);
    expect(test.body.attempt.status_code).toBe(204);
    await waitEvent('webhook.test', (e) => e.type === 'webhook.test');
    expect(rejected).toEqual([]);
  });
});

describe('§21.5.1 ban end to end, with user.joined / user.banned / user.unbanned', () => {
  it('a banned user loses refresh and access tokens and cannot sign in; unban lets them back in', async () => {
    const browser = new Browser(issuer());
    const user = await signUp(browser, uniqueEmail('banned'));
    const r = await authorizeCode(browser, { clientId: p.dev.clientId, redirectUri: p.dev.redirectUri, resource: `urn:platform:${p.dev.clientId}` });
    const tokens = r.tokens!;
    const joined = await waitEvent('user.joined', (e) => e.type === 'user.joined' && e.data.user_id === user.userId);
    expect(joined).toMatchObject({ product_id: p.productId, env: 'dev', data: { anonymous: false } });
    const me = () => api('/v1/me', { key: p.dev.publishableKey, token: tokens.access_token });
    expect((await me()).status).toBe(200);

    const ban = await admin(ownerToken, 'POST', `/users/${user.userId}/ban`, { reason: 'e2e: abuse report' });
    expect(ban.status).toBe(200);
    const banned = await waitEvent('user.banned', (e) => e.type === 'user.banned' && e.data.user_id === user.userId);
    expect(JSON.stringify(banned)).not.toContain('abuse report');

    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: p.dev.clientId });
    expect(refreshed.status).toBe(400);
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant');
    const denied = await me();
    expect([denied.status, (await errorOf(denied)).code]).toEqual([403, 'user_banned']);
    const signin = await new Browser(issuer()).request(`${issuer()}/login`, { form: { email: user.email, password: PASSWORD, oauth_query: '' } });
    expect(signin.status).toBe(403);
    expect(await signin.text()).toContain('This account has been banned');

    expect((await admin(ownerToken, 'DELETE', `/users/${user.userId}/ban`)).status).toBe(200);
    await waitEvent('user.unbanned', (e) => e.type === 'user.unbanned' && e.data.user_id === user.userId);
    const again = await new Browser(issuer()).request(`${issuer()}/api/auth/sign-in/email`, { json: { email: user.email, password: PASSWORD } });
    expect(again.status).toBe(200);
  });
});

describe('§21.5.2 support impersonation', () => {
  it('an owner with TOTP confirms on the identity domain; product tokens carry act; stop restores the owner', async () => {
    // A second owner who enrolls TOTP (the bootstrap owner has none).
    const ob = new Browser(issuer());
    const o = await signUp(ob, uniqueEmail('owner2'));
    expect((await admin(ownerToken, 'POST', '/team', { user_id: o.userId, role: 'owner' })).status).toBe(201);
    const setup = await (await ob.request(`${issuer()}/two-factor/setup`, { form: { password: PASSWORD, return: '' } })).text();
    const totpSecret = /data-totp-secret>([A-Z2-7]+)</.exec(setup)![1]!;
    expect((await ob.request(`${issuer()}/two-factor/setup/confirm`, { form: { code: await totp(totpSecret), return: '' } })).status).toBe(302);
    const o2Token = await consoleToken({ email: o.email, password: PASSWORD, totp: { secret: totpSecret } });

    const target = await signUp(new Browser(issuer()), uniqueEmail('target'));
    const req = await admin<{ id: string; url: string }>(o2Token, 'POST', `/users/${target.userId}/impersonations`, { reason: 'e2e: support ticket 77' });
    expect(req.status).toBe(201);
    expect((await ob.request(req.body.url)).status).toBe(200);
    const start = await ob.request(`${issuer()}/impersonation/${req.body.id}/start`, { form: { code: await totp(totpSecret) } });
    expect(start.status).toBe(302);
    expect(await (await ob.request(`${issuer()}/account`)).text()).toContain('data-impersonation-banner');

    const r = await authorizeCode(ob, { clientId: p.dev.clientId, redirectUri: p.dev.redirectUri, resource: `urn:platform:${p.dev.clientId}` });
    expect(decodeJwt(r.tokens!.access_token)).toMatchObject({ sub: target.userId, act: { sub: o.userId } });
    expect((await api('/v1/me', { key: p.dev.publishableKey, token: r.tokens!.access_token })).status).toBe(200);
    // The console cannot be reached from the support session.
    const consoleTry = await ob.request(`${issuer()}/api/auth/change-password`, { json: { currentPassword: PASSWORD, newPassword: 'x'.repeat(20) } });
    expect(consoleTry.status).toBe(403);

    expect((await ob.request(`${issuer()}/impersonation/stop`, { form: {} })).status).toBe(302);
    const s = (await (await ob.request(`${issuer()}/api/auth/get-session`, { json: undefined })).json()) as { user: { id: string } } | null;
    expect(s?.user.id).toBe(o.userId);
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r.tokens!.refresh_token!, client_id: p.dev.clientId });
    expect(refreshed.status).toBe(400);
  });
});
