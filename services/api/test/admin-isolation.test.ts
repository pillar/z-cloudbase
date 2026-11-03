// Cross-product isolation matrix for EVERY admin route (PRD §19.9): who may not do what, and that denied calls change nothing.
import { newId } from '@z-cloudbase/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, errorCode, initApp, makeWorld, seedUser, type Json, type World } from './admin-helpers.ts';
import { minter, seedMembership } from './helpers.ts';

const rpc = vi.hoisted(() => ({ upsertProductClient: vi.fn(), revokeUserTokens: vi.fn(), setUserBan: vi.fn() }));
vi.mock('../src/identity.ts', () => ({
  identity: () => ({ getJwks: async () => (globalThis as any).__testJwks, ...rpc }),
}));
vi.mock('../src/lib/analytics/index.ts', () => ({ analyticsQuery: () => ({ summary: async () => ({ daily: [], events_total: 0, top_events: [], source: 'd1_substitute' }) }) }));
vi.mock('../src/lib/logsearch/index.ts', () => ({ searchLogs: async () => [] }));

let w: World;
let bKeyId: string;
let bTeamId: string;
let bWebhookId: string;
const bUser = 'usr_iso_bob';

beforeAll(async () => {
  (globalThis as any).__testJwks = (await minter()).jwks;
  await initApp();
  w = await makeWorld('iso');
  await seedUser(bUser, 'bob@iso.example');
  await seedMembership(bUser, w.b);
  bKeyId = newId('cred');
  await env.DB.prepare(
    `INSERT INTO service_credentials (id, product_env_id, scopes, secret_hash, created_by, created_at) VALUES (?, ?, '["logs:write"]', ?, 'usr_seed', ?)`,
  ).bind(bKeyId, w.envs.b.dev, newId('hash'), Date.now()).run();
  bWebhookId = newId('whe');
  await env.DB.prepare(
    `INSERT INTO webhook_endpoints (id, product_env_id, url, event_types, enabled, secret, created_by, created_at, updated_at)
     VALUES (?, ?, 'https://hooks.example.com/b', '["user.joined"]', 1, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'usr_seed', ?, ?)`,
  ).bind(bWebhookId, w.envs.b.dev, Date.now(), Date.now()).run();
  bTeamId = newId('tm');
  await env.DB.prepare(`INSERT INTO team_members (id, user_id, role, product_id, created_at) VALUES (?, ?, 'product_developer', ?, ?)`)
    .bind(bTeamId, bUser, w.b, Date.now()).run();
});

interface Route {
  name: string;
  method: string;
  path: (w: World) => string;
  body?: (w: World) => unknown;
  /** Changes state (operators must be denied). */
  mutates: boolean;
}

const schema = { properties: {} };
// Every admin route, aimed at product B (the "victim" product).
const routes: Route[] = [
  { name: 'GET /products/:id', method: 'GET', path: (w) => `/products/${w.b}`, mutates: false },
  { name: 'PATCH /products/:id', method: 'PATCH', path: (w) => `/products/${w.b}`, body: () => ({ name: 'pwned' }), mutates: true },
  { name: 'PATCH /products/:id (status)', method: 'PATCH', path: (w) => `/products/${w.b}`, body: () => ({ status: 'disabled' }), mutates: true },
  { name: 'POST service-keys', method: 'POST', path: (w) => `/products/${w.b}/service-keys`, body: () => ({ env: 'dev', scopes: ['logs:write'] }), mutates: true },
  { name: 'GET service-keys', method: 'GET', path: (w) => `/products/${w.b}/service-keys`, mutates: false },
  { name: 'DELETE service-keys/:keyId', method: 'DELETE', path: (w) => `/products/${w.b}/service-keys/${bKeyId}`, mutates: true },
  { name: 'POST publishable-key/rotate', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/publishable-key/rotate`, mutates: true },
  { name: 'POST buckets', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/buckets`, body: () => ({ name: 'evil' }), mutates: true },
  { name: 'GET buckets', method: 'GET', path: (w) => `/products/${w.b}/environments/dev/buckets`, mutates: false },
  { name: 'POST event-schemas', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/event-schemas`, body: () => ({ event_name: 'evil', schema_version: 1, schema }), mutates: true },
  { name: 'GET environment settings', method: 'GET', path: (w) => `/products/${w.b}/environments/dev`, mutates: false },
  { name: 'PATCH environment settings', method: 'PATCH', path: (w) => `/products/${w.b}/environments/dev`, body: () => ({ daily_upload_quota_bytes: 1, allowed_extensions: ['exe'] }), mutates: true },
  { name: 'GET event-schemas', method: 'GET', path: (w) => `/products/${w.b}/environments/dev/event-schemas`, mutates: false },
  { name: 'GET products/:id/team', method: 'GET', path: (w) => `/products/${w.b}/team`, mutates: false },
  { name: 'POST /team (product role)', method: 'POST', path: (w) => '/team', body: (w) => ({ user_id: bUser, role: 'product_admin', product_id: w.b }), mutates: true },
  { name: 'DELETE /team/:id', method: 'DELETE', path: () => `/team/${bTeamId}`, mutates: true },
  { name: 'GET products/:id/memberships', method: 'GET', path: (w) => `/products/${w.b}/memberships`, mutates: false },
  { name: 'PATCH memberships/:userId', method: 'PATCH', path: (w) => `/products/${w.b}/memberships/${bUser}`, body: () => ({ status: 'revoked' }), mutates: true },
  { name: 'GET usage', method: 'GET', path: (w) => `/products/${w.b}/usage`, mutates: false },
  { name: 'GET analytics', method: 'GET', path: (w) => `/products/${w.b}/analytics?env=dev`, mutates: false },
  { name: 'GET logs', method: 'GET', path: (w) => `/products/${w.b}/logs?env=dev`, mutates: false },
  { name: 'GET /audit?product_id', method: 'GET', path: (w) => `/audit?product_id=${w.b}`, mutates: false },
  // PRD §21.5.3 / §21.6
  { name: 'GET users/export', method: 'GET', path: (w) => `/products/${w.b}/environments/dev/users/export`, mutates: false },
  { name: 'GET webhooks', method: 'GET', path: (w) => `/products/${w.b}/environments/dev/webhooks`, mutates: false },
  { name: 'POST webhooks', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/webhooks`, body: () => ({ url: 'https://evil.example/x', event_types: ['user.joined'] }), mutates: true },
  { name: 'PATCH webhooks/:id', method: 'PATCH', path: (w) => `/products/${w.b}/environments/dev/webhooks/${bWebhookId}`, body: () => ({ url: 'https://evil.example/x' }), mutates: true },
  { name: 'DELETE webhooks/:id', method: 'DELETE', path: (w) => `/products/${w.b}/environments/dev/webhooks/${bWebhookId}`, mutates: true },
  { name: 'POST webhooks/:id/rotate-secret', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/webhooks/${bWebhookId}/rotate-secret`, mutates: true },
  { name: 'POST webhooks/:id/test', method: 'POST', path: (w) => `/products/${w.b}/environments/dev/webhooks/${bWebhookId}/test`, mutates: true },
  { name: 'GET webhooks/:id/deliveries', method: 'GET', path: (w) => `/products/${w.b}/environments/dev/webhooks/${bWebhookId}/deliveries`, mutates: false },
];
// Platform-level routes that product-scoped principals must never reach.
const platformRoutes: Route[] = [
  { name: 'POST /products', method: 'POST', path: () => '/products', body: () => ({ product_id: 'iso_new', name: 'x' }), mutates: true },
  { name: 'GET /team', method: 'GET', path: () => '/team', mutates: false },
  { name: 'POST /team (platform role)', method: 'POST', path: () => '/team', body: () => ({ user_id: bUser, role: 'owner' }), mutates: true },
  { name: 'GET /audit (platform-wide)', method: 'GET', path: () => '/audit', mutates: false },
  // PRD §21.5: owner-only user management
  { name: 'POST /users/:id/ban', method: 'POST', path: () => `/users/${bUser}/ban`, body: () => ({ reason: 'x' }), mutates: true },
  { name: 'DELETE /users/:id/ban', method: 'DELETE', path: () => `/users/${bUser}/ban`, mutates: true },
  { name: 'POST /users/:id/impersonations', method: 'POST', path: () => `/users/${bUser}/impersonations`, body: () => ({ reason: 'support ticket 1234' }), mutates: true },
];

async function snapshot() {
  const tables = [
    'products', 'product_environments', 'service_credentials', 'storage_buckets', 'event_schemas', 'team_members', 'product_memberships', 'audit_log',
    'webhook_endpoints', 'webhook_messages', 'webhook_deliveries', 'impersonations', '"user"',
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  return JSON.stringify(out);
}

describe('product A principals cannot reach product B through any admin route', () => {
  it.each(routes.map((r) => [r.name, r] as const))('%s', async (_n, r) => {
    const before = await snapshot();
    for (const who of ['adminA', 'devA', 'nobody'] as const) {
      const res = await api(w.tok[who], r.method, r.path(w), r.body?.(w));
      expect([who, res.status, await errorCode(res)]).toEqual([who, 403, 'forbidden']);
    }
    expect(await snapshot()).toBe(before);
    expect(rpc.upsertProductClient).not.toHaveBeenCalled();
    expect(rpc.revokeUserTokens).not.toHaveBeenCalled();
    expect(rpc.setUserBan).not.toHaveBeenCalled();
  });
});

describe('platform-level routes are closed to product-scoped principals', () => {
  it.each(platformRoutes.map((r) => [r.name, r] as const))('%s', async (_n, r) => {
    const before = await snapshot();
    for (const who of ['adminA', 'devA', 'adminB', 'nobody'] as const) {
      expect([who, (await api(w.tok[who], r.method, r.path(w), r.body?.(w))).status]).toEqual([who, 403]);
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('operators are read-only', () => {
  it.each(routes.concat(platformRoutes).filter((r) => r.mutates).map((r) => [r.name, r] as const))('%s', async (_n, r) => {
    const before = await snapshot();
    const res = await api(w.tok.operator, r.method, r.path(w), r.body?.(w));
    expect([res.status, await errorCode(res)]).toEqual([403, 'forbidden']);
    expect(await snapshot()).toBe(before);
  });

  it('but may read product details, logs and analytics', async () => {
    for (const p of [`/products/${w.a}`, `/products/${w.a}/logs?env=dev`, `/products/${w.a}/analytics?env=dev`, `/products/${w.a}/usage`, '/audit']) {
      expect([p, (await api(w.tok.operator, 'GET', p)).status]).toEqual([p, 200]);
    }
  });
});

describe('product developers inside their own product', () => {
  it('cannot use user, team, settings or production-key routes of product A either', async () => {
    const denied: Array<[string, string, unknown?]> = [
      ['PATCH', `/products/${w.a}`, { name: 'x' }],
      ['GET', `/products/${w.a}/team`],
      ['GET', `/products/${w.a}/memberships`],
      ['GET', '/users?user_id=usr_x'],
      ['PATCH', `/products/${w.a}/memberships/${bUser}`, { status: 'revoked' }],
      ['POST', `/products/${w.a}/service-keys`, { env: 'prod', scopes: ['logs:write'] }],
      ['GET', `/products/${w.a}/service-keys?env=prod`],
      ['POST', `/products/${w.a}/environments/prod/publishable-key/rotate`],
      ['POST', `/products/${w.a}/environments/dev/buckets`, { name: 'x1' }],
      ['GET', `/audit?product_id=${w.a}`],
    ];
    for (const [m, p, b] of denied) expect([m, p, (await api(w.tok.devA, m, p, b)).status]).toEqual([m, p, 403]);
  });
});

describe('authentication', () => {
  const sample = [...routes, ...platformRoutes];

  it('rejects product (non-console) access tokens with 401 on every route', async () => {
    for (const r of sample) {
      const res = await api(w.tok.product, r.method, r.path(w), r.body?.(w));
      expect([r.name, res.status, await errorCode(res)]).toEqual([r.name, 401, 'invalid_token']);
    }
  });

  it('rejects missing and garbage tokens with 401 on every route', async () => {
    for (const r of sample) {
      expect([r.name, (await api(null, r.method, r.path(w), r.body?.(w))).status]).toEqual([r.name, 401]);
      expect([r.name, (await api('abc.def.ghi', r.method, r.path(w), r.body?.(w))).status]).toEqual([r.name, 401]);
    }
  });

  it('GET /me returns only the caller\'s own grants', async () => {
    const me = (await (await api(w.tok.adminA, 'GET', '/me')).json()) as Json;
    expect(me).toEqual({ user_id: w.users.adminA, grants: [{ role: 'product_admin', productId: w.a }] });
    expect((await api(w.tok.product, 'GET', '/me')).status).toBe(401);
    expect((await api(w.tok.nobody, 'GET', '/me')).status).toBe(403);
  });

  it('GET /users never reveals product B\'s members to product A\'s admin', async () => {
    for (const q of [`user_id=${bUser}`, 'email=bob@iso.example']) {
      expect(await errorCode(await api(w.tok.adminA, 'GET', `/users?${q}`))).toBe('not_found');
    }
  });

  it('GET /products lists only the caller\'s own products', async () => {
    const ids = (r: Json) => r.products.map((p: Json) => p.id);
    expect(ids((await (await api(w.tok.adminA, 'GET', '/products')).json()) as Json)).toEqual([w.a]);
    expect((await api(w.tok.nobody, 'GET', '/products')).status).toBe(403);
  });
});
