import type { ServiceScope } from '@z-cloudbase/contracts';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../context.ts';
import { requireScope } from '../../middleware/auth.ts';

/** Service keys must hold `scope`; publishable keys pass (their endpoint-specific limits apply instead). */
export const serviceScopeOnly = (scope: ServiceScope): MiddlewareHandler<AppEnv> => (c, next) =>
  c.get('cred').kind === 'service' ? requireScope(scope)(c, next) : next();
