import { createAnalytics, type AnalyticsOptions } from './analytics.ts';
import { createSessionTracker, startPageViews, type AutocaptureOptions } from './autocapture.ts';
import { createAuth } from './auth.ts';
import type { ClientConfig } from './config.ts';
import { createLogs } from './logs.ts';
import { createStorage } from './storage.ts';

export type { ClientConfig, KeyValueStore } from './config.ts';
export { PlatformError } from './errors.ts';
export type { Auth, AuthUser, Me } from './auth.ts';
export type { AnalyticsOptions } from './analytics.ts';
export type { AutocaptureOptions } from './autocapture.ts';
export type { CreateUploadParams, ListObjectsResponse } from './storage.ts';

/**
 * One client with every module. Apps that want a smaller bundle import the factories from
 * `@z-cloudbase/web/auth`, `/storage`, `/analytics` and `/logs` instead.
 */
export function createClient(
  config: ClientConfig & { analytics?: AnalyticsOptions; autocapture?: AutocaptureOptions },
) {
  const auth = createAuth(config);
  const ac = config.autocapture;
  const session = ac?.sessions ? createSessionTracker(config) : undefined;
  const analytics = createAnalytics(config, auth, { ...config.analytics, ...(session ? { session } : {}) });
  const stopPageViews = ac?.pageViews ? startPageViews(analytics.track) : undefined;
  return {
    auth,
    storage: createStorage(config, auth),
    analytics,
    logs: createLogs(config),
    /** Stop autocapture listeners (restores history methods) and analytics timers/listeners. */
    dispose(): void {
      stopPageViews?.();
      analytics.destroy();
    },
  };
}
