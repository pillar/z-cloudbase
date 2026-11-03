import { createAnalytics } from './analytics.ts';
import { createAuth } from './auth.ts';
import { createBff, type BffOptions } from './bff.ts';
import { createHttp, validateConfig, type ServerClientConfig } from './http.ts';
import { createLogs } from './logs.ts';
import { createOidc } from './oidc.ts';
import { createStorage } from './storage.ts';
import type { PlatformError } from './errors.ts';

export type { ServerClientConfig } from './http.ts';
export { PlatformError } from './errors.ts';
export type { BffOptions, BffTokens } from './bff.ts';
export type { ExpectedProduct } from './auth.ts';
export type { LogMeta } from './logs.ts';
export type { ServerEventOptions } from './analytics.ts';
export type { CreateUploadParams } from './storage.ts';
export type { AccessTokenClaims, ActorClaim } from '@z-cloudbase/contracts';
// Product webhooks (PRD §21.6).
export { verifyWebhook, type VerifyWebhookOptions, type WebhookEvent, type WebhookEventType } from './webhooks.ts';

/**
 * Server-side client authenticated with a service key. Works in Node, Workers and other fetch
 * runtimes. `logs` and `analytics` buffer in memory: call `flush()` before the request or
 * process ends (in Workers: `ctx.waitUntil(client.flush())`), or set `flushIntervalMs`.
 */
export function createServerClient(config: ServerClientConfig & { onError?: (e: PlatformError) => void }) {
  validateConfig(config);
  const http = createHttp(config);
  const oidc = createOidc(config);
  const batching = { flushIntervalMs: config.flushIntervalMs, onError: config.onError };
  const logs = createLogs(http, batching);
  const analytics = createAnalytics(http, batching);
  return {
    auth: createAuth(oidc),
    logs,
    analytics,
    storage: createStorage(http, config),
    /** Cookie-based login for a server-rendered product (confidential client). */
    bff: (options: BffOptions) => createBff(oidc, options),
    /** Flush logs and events together. */
    flush: () => Promise.all([logs.flush(), analytics.flush()]).then(() => undefined),
  };
}
