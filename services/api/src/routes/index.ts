import type { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { meRoutes } from './me/index.ts';
import { storageRoutes } from './storage/index.ts';
import { eventsRoutes } from './events/index.ts';
import { logsRoutes } from './logs/index.ts';
import { adminRoutes } from './admin/index.ts';

// Route registry. Each module lives in its own folder under src/routes/<module>/
// and adds exactly one line here (keeps parallel work conflict-free).
export function registerRoutes(app: Hono<AppEnv>): void {
  app.route('/v1/me', meRoutes);
  app.route('/v1/storage', storageRoutes);
  app.route('/v1/logs', logsRoutes);
  app.route('/v1/events', eventsRoutes);
  app.route('/v1/admin', adminRoutes);
}
