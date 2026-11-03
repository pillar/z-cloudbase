import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler, requestId } from '@z-cloudbase/security';
import type { AppEnv } from './context.ts';
import { registerRoutes } from './routes/index.ts';

export type { AppEnv };

const app = new Hono<AppEnv>();
app.use(requestId());
app.onError(errorHandler);
// Preflight carries no X-Platform-Key; real requests are origin-checked by withCredential (allowed_origins).
app.use('/v1/*', cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Platform-Key', 'Idempotency-Key'],
  exposeHeaders: ['x-request-id'],
  maxAge: 600,
}));

app.get('/health', (c) => c.json({ ok: true, service: 'api' }));
registerRoutes(app);

export default app;
