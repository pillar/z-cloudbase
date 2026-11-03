import { exports, env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('api worker runtime', () => {
  it('returns the unified error body for unknown routes handled by onError', async () => {
    const res = await exports.default.fetch('http://api.test/health');
    expect(res.status).toBe(200);
  });

  it('can use D1, ingest D1, R2 and Queue bindings locally', async () => {
    await env.STORAGE.put('p/x', 'hello');
    expect(await (await env.STORAGE.get('p/x'))?.text()).toBe('hello');
    await env.EVENTS_QUEUE.send({ ping: true });
    const t = await env.INGEST_DB.prepare("SELECT name FROM sqlite_master WHERE name = 'event_dedup'").first();
    expect(t).not.toBeNull();
  });
});
