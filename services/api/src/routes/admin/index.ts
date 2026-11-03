import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { withConsoleUser } from '../../middleware/auth.ts';
import { analyticsRoutes } from './analytics.ts';
import { configRoutes } from './config.ts';
import { insightRoutes } from './insights.ts';
import { invitationRoutes } from './invitations.ts';
import { keyRoutes } from './keys.ts';
import { productRoutes } from './products.ts';
import { teamRoutes } from './team.ts';
import { userRoutes } from './users.ts';
import { webhookRoutes } from './webhooks.ts';

// Admin API, mounted at /v1/admin (PRD §19.9). Console tokens only; every route below also calls
// authorize() with its own Action and writes an audit entry for each mutation.
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', withConsoleUser());

/** The caller's own grants, so the console can hide actions the server would refuse. */
adminRoutes.get('/me', (c) => c.json({ user_id: c.get('admin').userId, grants: c.get('admin').grants }));

adminRoutes.route('/', productRoutes);
adminRoutes.route('/', keyRoutes);
adminRoutes.route('/', configRoutes);
adminRoutes.route('/', teamRoutes);
adminRoutes.route('/', userRoutes);
adminRoutes.route('/', insightRoutes);
adminRoutes.route('/', analyticsRoutes);
adminRoutes.route('/', invitationRoutes);
adminRoutes.route('/', webhookRoutes);
