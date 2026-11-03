import { exports, env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('identity worker runtime', () => {
  it('serves health with a request id', async () => {
    const res = await exports.default.fetch('http://identity.test/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('has the platform schema applied to D1', async () => {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'products'").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
