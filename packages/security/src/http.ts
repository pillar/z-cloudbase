import { ApiError, newRequestId } from '@z-cloudbase/contracts';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';

export type RequestIdVars = { requestId: string };

/** Assigns `req_<uuidv7>` to every request and echoes it in `x-request-id` (PRD §19.3). */
export const requestId = (): MiddlewareHandler<{ Variables: RequestIdVars }> => async (c, next) => {
  const id = newRequestId();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

/** Maps errors to the unified error body (PRD §19.5). Unknown errors become `internal`. */
export const errorHandler: ErrorHandler = (err, c: Context) => {
  const rid: string = c.get('requestId') ?? newRequestId();
  const apiError = err instanceof ApiError ? err : null;
  if (!apiError) console.error(JSON.stringify({ request_id: rid, error: String(err), stack: (err as Error)?.stack }));
  const e = apiError ?? new ApiError('internal', 'Internal error');
  if (e.code === 'rate_limited') c.header('Retry-After', '60');
  return c.json(e.toBody(rid), e.status as 400);
};
