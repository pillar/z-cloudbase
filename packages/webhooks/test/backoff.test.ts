import { WEBHOOK_MAX_ATTEMPTS, webhookBackoffS } from '@z-cloudbase/contracts';
import { describe, expect, it } from 'vitest';
import { outboxStatements } from '../src/index.ts';

describe('webhook retry schedule (PRD §21.6)', () => {
  it('doubles from 15 minutes, caps at 12 hours, and gives up after 8 attempts (~28 h)', () => {
    const delays = Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) => webhookBackoffS(i + 1) / 60);
    expect(delays).toEqual([15, 30, 60, 120, 240, 480, 720]);
    expect(delays.reduce((a, b) => a + b, 0) / 60).toBeCloseTo(27.75);
  });
});

describe('outbox statements', () => {
  it('fix the payload envelope and only target the given product environment', () => {
    const { messageId, statements } = outboxStatements({
      target: { productEnvId: 'game_a.dev', productId: 'game_a', env: 'dev' },
      type: 'user.banned', data: { user_id: 'usr_1', expires_at: null }, now: Date.UTC(2026, 10, 4),
    });
    expect(messageId).toMatch(/^msg_/);
    const payload = JSON.parse(statements[0]!.binds[3] as string);
    expect(payload).toEqual({
      id: messageId, type: 'user.banned', timestamp: '2026-11-04T00:00:00.000Z', product_id: 'game_a', env: 'dev',
      data: { user_id: 'usr_1', expires_at: null },
    });
    expect(statements[0]!.binds).toContain('game_a.dev');
  });
});
