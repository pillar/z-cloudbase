// Fixtures for admin API tests: a two-product world with one principal per role.
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { minter, seedProduct, seedTeamMember } from './helpers.ts';

export type Json = Record<string, any>;

type App = { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
let app: App;

/**
 * Load the real app (routes mounted as in production) with this file's `vi.mock`s applied. The worker entry
 * (src/index.ts) is already loaded by the test pool with the real modules, so the registry is reset first;
 * without this, mocks only reach modules the test file imports directly.
 */
export async function initApp(): Promise<void> {
  vi.resetModules();
  app = (await import('../src/index.ts')).default;
}

/** Raw request, for malformed bodies. */
export const rawRequest = (path: string, init: RequestInit) => app.request(`/v1/admin${path}`, init, env);

/** Calls the app with the given console/product token. */
export async function api(token: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    `/v1/admin${path}`,
    {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

export const errorCode = async (res: Response) => ((await res.json()) as Json).error?.code as string | undefined;

export async function seedUser(id: string, email: string, name = 'Test User') {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous) VALUES (?, ?, ?, 1, ?, ?, 0)`,
  ).bind(id, name, email, now, now).run();
}

export interface World {
  a: string;
  b: string;
  /** product environment ids, e.g. `a.prod` */
  envs: Record<'a' | 'b', Record<'dev' | 'staging' | 'prod', string>>;
  tok: Record<'owner' | 'operator' | 'adminA' | 'devA' | 'adminB' | 'nobody' | 'product', string>;
  users: Record<'owner' | 'operator' | 'adminA' | 'devA' | 'adminB', string>;
}

/** Products `${prefix}_a` / `${prefix}_b` with all three environments, and one principal per role. */
export async function makeWorld(prefix: string): Promise<World> {
  const a = `${prefix}_a`;
  const b = `${prefix}_b`;
  const envs = { a: {}, b: {} } as World['envs'];
  for (const [k, id] of [['a', a], ['b', b]] as const) {
    for (const e of ['dev', 'staging', 'prod'] as const) envs[k][e] = (await seedProduct({ productId: id, env: e })).productEnvId;
  }
  const users = {
    owner: `usr_${prefix}_owner`, operator: `usr_${prefix}_operator`, adminA: `usr_${prefix}_admin_a`,
    devA: `usr_${prefix}_dev_a`, adminB: `usr_${prefix}_admin_b`,
  };
  await seedTeamMember(users.owner, 'owner');
  await seedTeamMember(users.operator, 'operator');
  await seedTeamMember(users.adminA, 'product_admin', a);
  await seedTeamMember(users.devA, 'product_developer', a);
  await seedTeamMember(users.adminB, 'product_admin', b);
  const m = await minter();
  const tok = {
    owner: await m.mintConsole({ userId: users.owner }),
    operator: await m.mintConsole({ userId: users.operator }),
    adminA: await m.mintConsole({ userId: users.adminA }),
    devA: await m.mintConsole({ userId: users.devA }),
    adminB: await m.mintConsole({ userId: users.adminB }),
    nobody: await m.mintConsole({ userId: `usr_${prefix}_nobody` }),
    // A valid *product* token (not a console token) for a user who is also a team member.
    product: await m.mint({ productId: a, env: 'prod', userId: users.adminA }),
  };
  return { a, b, envs, tok, users };
}

export async function auditRows(action: string, productId?: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM audit_log WHERE action = ? ${productId ? 'AND product_id = ?' : ''} ORDER BY occurred_at`,
  ).bind(...(productId ? [action, productId] : [action])).all<Json>();
  return results;
}

export const dbValue = async <T = Json>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
