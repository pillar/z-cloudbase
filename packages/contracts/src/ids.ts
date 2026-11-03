// Identifier and key formats — PRD §19.3.

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const PRODUCT_ID_RE = /^[a-z][a-z0-9_]{2,31}$/;
/** Reserved OIDC client for the platform console (PRD §19.9). Not a product; `products` must never use this id. */
export const CONSOLE_CLIENT_ID = 'platform_console';
export const RESERVED_PRODUCT_IDS: readonly string[] = [CONSOLE_CLIENT_ID];

export function isEnvironment(v: unknown): v is Environment {
  return typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);
}

/** OIDC client_id and access-token `aud`: `{product_id}.{env}`. */
export function clientId(productId: string, env: Environment): string {
  return `${productId}.${env}`;
}

/**
 * Access-token audience for a product environment: RFC 8707 resource URI wrapping the
 * client_id (the auth engine requires an absolute URI as `aud`). PRD §19.3 / §19.4.
 */
export const productAudience = (clientIdValue: string) => `urn:platform:${clientIdValue}`;

/** Path of the identity domain's OIDC userinfo endpoint (engine-defined). */
export const USERINFO_PATH = '/api/auth/oauth2/userinfo';
/** Audience the engine appends when `openid` is granted; the only extra `aud` member allowed. */
export const userinfoAudience = (issuer: string) => `${issuer}${USERINFO_PATH}`;

export function parseClientId(value: string): { productId: string; env: Environment } | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const productId = value.slice(0, dot);
  const env = value.slice(dot + 1);
  if (!PRODUCT_ID_RE.test(productId) || !isEnvironment(env)) return null;
  return { productId, env };
}

/** RFC 9562 UUIDv7. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const newUserId = () => `usr_${uuidv7()}`;
export const newRequestId = () => `req_${uuidv7()}`;
export const newId = (prefix: string) => `${prefix}_${uuidv7()}`;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform base62 string from `bytes` of entropy (rejection sampling, no modulo bias). */
export function randomBase62(bytes: number): string {
  const length = Math.ceil((bytes * 8) / Math.log2(62));
  let out = '';
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const x of buf) {
      if (x < 248 && out.length < length) out += BASE62[x % 62];
    }
  }
  return out;
}

export const PUBLISHABLE_KEY_RE = /^pk_(dev|staging|prod)_[0-9A-Za-z]{33}$/;
export const SERVICE_KEY_RE = /^sk_(dev|staging|prod)_[0-9A-Za-z]{43}$/;

export const newPublishableKey = (env: Environment) => `pk_${env}_${randomBase62(24)}`;
export const newServiceKey = (env: Environment) => `sk_${env}_${randomBase62(32)}`;

export function keyEnvironment(key: string): Environment | null {
  const m = PUBLISHABLE_KEY_RE.exec(key) ?? SERVICE_KEY_RE.exec(key);
  return m ? (m[1] as Environment) : null;
}

/** Audience of console access tokens (admin API). Console tokens carry no pid/env. */
export const CONSOLE_AUDIENCE = productAudience(CONSOLE_CLIENT_ID);

/**
 * Event names (PRD §4.5): lowercase snake_case, up to 64 characters. Lives here, outside the zod schemas,
 * so the Web SDK can validate names without bundling zod.
 */
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
