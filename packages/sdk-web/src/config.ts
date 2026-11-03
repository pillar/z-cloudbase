import { PRODUCT_ID_RE, PUBLISHABLE_KEY_RE, keyEnvironment, type Environment } from '@z-cloudbase/contracts';
import { PlatformError } from './errors.ts';

/** Minimal Storage shape, so tests and custom stores can be used. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ClientConfig {
  /** API origin; calls go to `{endpoint}/v1/...`. */
  endpoint: string;
  /** Identity (OIDC issuer) origin. */
  issuer: string;
  productId: string;
  env: Environment;
  publishableKey: string;
  /** Where the identity service sends the browser back after sign-in. */
  redirectUri: string;
  /**
   * Persistence for the refresh token only (e.g. `sessionStorage`). Omit to keep it in memory;
   * access tokens are never persisted.
   */
  storage?: KeyValueStore;
  fetch?: typeof fetch;
  /** Per-request timeout, default 15s. */
  timeoutMs?: number;
  /** First retry delay for retryable failures (doubles each attempt), default 500ms. */
  retryBaseMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_BASE_MS = 500;

/** Fail fast on misconfiguration (wrong key kind, key for another env, bad product id). */
export function validateConfig(c: ClientConfig): void {
  const bad = (m: string) => new PlatformError('sdk_error', m);
  if (!PRODUCT_ID_RE.test(c.productId)) throw bad('Invalid productId');
  if (!PUBLISHABLE_KEY_RE.test(c.publishableKey)) throw bad('publishableKey must be a pk_ key');
  if (keyEnvironment(c.publishableKey) !== c.env) throw bad('publishableKey belongs to a different env');
}
