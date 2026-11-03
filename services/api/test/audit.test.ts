// Audit rows written for an end user's request (PRD §4.4, §21.5.2): during a support impersonation the
// owner acting for the user is recorded as metadata.actor_id.
import { newUserId } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/context.ts';
import { requestAuditStatement } from '../src/lib/audit.ts';

function appFor(actor?: string) {
  const app = new Hono<AppEnv>();
  app.post('/x', async (c) => {
    const userId = c.req.header('x-user')!;
    c.set('requestId', 'req_test');
    c.set('user', { userId, anon: false, sessionId: 'ses_x', ...(actor ? { actor } : {}) });
    await requestAuditStatement(c, { actorType: 'user', actorId: userId, action: 'test.audit', targetType: 'user', targetId: userId, metadata: { k: 1 } }).run();
    return c.body(null, 204);
  });
  return app;
}

const row = (userId: string) =>
  env.DB.prepare(`SELECT actor_id, request_id, metadata FROM audit_log WHERE action = 'test.audit' AND target_id = ?`).bind(userId).first<{ actor_id: string; request_id: string; metadata: string }>();

describe('requestAuditStatement', () => {
  it('records the impersonating owner as metadata.actor_id', async () => {
    const userId = newUserId();
    await appFor('usr_owner').request('/x', { method: 'POST', headers: { 'x-user': userId } }, env);
    const r = await row(userId);
    expect(r).toMatchObject({ actor_id: userId, request_id: 'req_test' });
    expect(JSON.parse(r!.metadata)).toEqual({ k: 1, actor_id: 'usr_owner' });
  });

  it('adds nothing for the user acting themselves', async () => {
    const userId = newUserId();
    await appFor().request('/x', { method: 'POST', headers: { 'x-user': userId } }, env);
    expect(JSON.parse((await row(userId))!.metadata)).toEqual({ k: 1 });
  });
});
