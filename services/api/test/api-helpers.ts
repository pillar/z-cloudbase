// Request helpers for me/storage/idempotency tests (kept apart from the lead-owned helpers.ts).
import { env } from 'cloudflare:workers';
import { newId } from '@z-cloudbase/contracts';
import { vi } from 'vitest';
import app from '../src/index.ts';
import { minter } from './helpers.ts';

export async function seedBucket(productEnvId: string, name: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO storage_buckets (id, product_env_id, name, created_at) VALUES (?, ?, ?, ?)`)
    .bind(newId('bkt'), productEnvId, name, Date.now()).run();
}

/**
 * Stand-in for the IDENTITY service binding, injected through the `env` argument of `app.request`.
 * (vi.mock of src/identity.ts does not work once src/index.ts, which imports identity.ts via the
 * routes, is part of the worker entry graph: the entry loads the real module before the mock exists.)
 */
export const identityStub = {
  getJwks: async () => (await minter()).jwks,
  revokeUserTokens: vi.fn(async (_input: unknown) => {}),
};

export interface CallOpts {
  method?: string;
  key?: string;
  token?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  /** overrides merged over the test env, e.g. { DEPLOY_ENV: 'production' } */
  env?: Record<string, unknown>;
}

export async function call(path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers['X-Platform-Key'] = o.key;
  if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
  let body: BodyInit | undefined = o.rawBody;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  return app.request(path, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body }, { ...env, IDENTITY: identityStub, ...o.env } as unknown as Env);
}

export const errCode = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

/** Strip origin from a signed URL so it can be fed to `app.request`. */
export const pathOf = (url: string) => new URL(url).pathname;

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
