import { describe, expect, it } from 'vitest';
import { pickEnv } from '../src/productEnv.tsx';
import { parseHash } from '../src/route.ts';

describe('parseHash', () => {
  it('reads product, section and a known env', () => {
    expect(parseHash('#/p/demo_game/logs?env=dev')).toEqual({ productId: 'demo_game', section: 'logs', env: 'dev' });
    expect(parseHash('#/p/demo_game/logs')).toEqual({ productId: 'demo_game', section: 'logs' });
    expect(parseHash('#/p/demo_game?env=staging')).toEqual({ productId: 'demo_game', env: 'staging' });
    expect(parseHash('#/p/demo_game/logs?env=qa')).toEqual({ productId: 'demo_game', section: 'logs' });
  });

  it('keeps the other routes', () => {
    expect(parseHash('#/invitations')).toEqual({ platformPage: 'invitations' });
    expect(parseHash('#/')).toEqual({});
    expect(parseHash('')).toEqual({});
  });
});

describe('pickEnv', () => {
  it('keeps a wanted env the product has, otherwise prefers prod', () => {
    expect(pickEnv(['dev', 'staging', 'prod'], 'dev')).toBe('dev');
    expect(pickEnv(['dev', 'staging', 'prod'], null)).toBe('prod');
    expect(pickEnv(['dev', 'prod'], 'staging')).toBe('prod');
    expect(pickEnv(['dev', 'staging'], null)).toBe('dev');
  });
});
