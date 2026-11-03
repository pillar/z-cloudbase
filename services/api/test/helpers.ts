// Shared test fixtures for api tests. Seeds platform rows directly in D1.
import {
  DEFAULT_MAX_OBJECT_BYTES, DEFAULT_PRODUCT_QUOTA_BYTES, clientId, newId, newPublishableKey, newServiceKey,
  newUserId, type Environment, type Role, type ServiceScope,
} from '@z-cloudbase/contracts';
import { sha256Hex } from '@z-cloudbase/security';
import { createTestTokenMinter, type TestTokenMinter } from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';

export const ISSUER = env.ISSUER;

let minterPromise: Promise<TestTokenMinter> | null = null;
/** One signing key per test file; wire it in with `vi.mock('../src/identity.ts', ...)` (see auth-context.test.ts). */
export function minter(): Promise<TestTokenMinter> {
  minterPromise ??= createTestTokenMinter(ISSUER);
  return minterPromise;
}

export interface SeededEnv {
  productId: string;
  env: Environment;
  productEnvId: string;
  publishableKey: string;
  salt: string;
}

export async function seedProduct(opts: {
  productId: string;
  env?: Environment;
  status?: 'active' | 'disabled' | 'archived';
  visibility?: 'open' | 'restricted';
  allowedOrigins?: string[];
  quotaBytes?: number;
  maxObjectBytes?: number;
  allowedMimeTypes?: string[];
}): Promise<SeededEnv> {
  const e = opts.env ?? 'prod';
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO products (id, name, status, visibility, allowed_origins, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(opts.productId, opts.productId, opts.status ?? 'active', opts.visibility ?? 'open', JSON.stringify(opts.allowedOrigins ?? []), now, now).run();
  const productEnvId = clientId(opts.productId, e);
  const publishableKey = newPublishableKey(e);
  const salt = newId('salt');
  await env.DB.prepare(
    `INSERT INTO product_environments (id, product_id, env, publishable_key, user_key_salt, storage_quota_bytes, max_object_bytes, allowed_mime_types, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    productEnvId, opts.productId, e, publishableKey, salt, opts.quotaBytes ?? DEFAULT_PRODUCT_QUOTA_BYTES,
    opts.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES, JSON.stringify(opts.allowedMimeTypes ?? []), now,
  ).run();
  return { productId: opts.productId, env: e, productEnvId, publishableKey, salt };
}

export async function seedServiceKey(productEnvId: string, scopes: ServiceScope[], opts: { revoked?: boolean } = {}): Promise<string> {
  const e = productEnvId.split('.').pop() as Environment;
  const key = newServiceKey(e);
  await env.DB.prepare(
    `INSERT INTO service_credentials (id, product_env_id, scopes, secret_hash, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId('cred'), productEnvId, JSON.stringify(scopes), await sha256Hex(key), 'usr_seed', Date.now(), opts.revoked ? Date.now() : null).run();
  return key;
}

export async function seedMembership(userId: string, productId: string, status: 'active' | 'suspended' | 'revoked' = 'active') {
  await env.DB.prepare(`INSERT OR REPLACE INTO product_memberships (user_id, product_id, status, joined_at) VALUES (?, ?, ?, ?)`)
    .bind(userId, productId, status, Date.now()).run();
}

export async function seedTeamMember(userId: string, role: Role, productId: string | null = null) {
  await env.DB.prepare(`INSERT INTO team_members (id, user_id, role, product_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(newId('tm'), userId, role, productId, Date.now()).run();
}

/** A user with an active membership in `product` and a valid access token for it. */
export async function userFor(product: SeededEnv, opts: { anon?: boolean } = {}) {
  const userId = newUserId();
  await seedMembership(userId, product.productId);
  const token = await (await minter()).mint({ productId: product.productId, env: product.env, userId, anon: opts.anon ?? false });
  return { userId, token };
}
