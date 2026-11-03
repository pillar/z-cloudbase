import { ApiError } from '@z-cloudbase/contracts';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../context.ts';

/**
 * Per-credential ingestion rate limit (PRD §19.6: 600 batches / key / minute, configured on the
 * INGEST_LIMITER binding). Must run after `withCredential`.
 */
export const ingestRateLimit = (route: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  const cred = c.get('cred');
  const { success } = await c.env.INGEST_LIMITER.limit({ key: `${route}:${cred.credentialId ?? cred.productEnvId}` });
  if (!success) throw new ApiError('rate_limited', 'Too many batches for this key');
  await next();
};
