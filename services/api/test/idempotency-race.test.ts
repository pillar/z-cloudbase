// withIdempotency under races (PRD §19.5): the handler must never run without owning the reservation.
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { errorHandler, requestId, sha256Hex } from '@z-cloudbase/security';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/context.ts';
import { withIdempotency } from '../src/lib/idempotency.ts';

const ROUTE = 'POST /test';
const BODY = '{"a":1}';

/** Minimal app exposing withIdempotency; each test passes its own handler and (optionally) a wrapped DB. */
function makeApp(handler: () => Promise<{ status: number; body: unknown }>) {
  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.onError(errorHandler);
  app.use(async (c, next) => {
    c.set('cred', { kind: 'service', credentialId: 'cred_race' } as never);
    await next();
  });
  app.post('/test', async (c) => withIdempotency(c, ROUTE, await c.req.text(), handler));
  return app;
}
const request = (app: ReturnType<typeof makeApp>, key: string, db: unknown = env.DB) =>
  app.request('/test', { method: 'POST', headers: { 'Idempotency-Key': key, 'content-type': 'application/json' }, body: BODY }, { ...env, DB: db } as never);

/** D1 wrapper that runs hooks around every read of idempotency_keys (to simulate other requests interleaving). */
function dbWithHook(beforeSelect: () => Promise<void>, afterSelect: () => Promise<void> = async () => {}) {
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === 'first' && sql.startsWith('SELECT request_hash')) {
          return async (...args: unknown[]) => {
            await beforeSelect();
            const row = await (target.first as (...a: unknown[]) => Promise<unknown>)(...args);
            await afterSelect();
            return row;
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const reserveRow = async (key: string) =>
  env.DB.prepare(`INSERT INTO idempotency_keys (principal, route, key, request_hash, status_code, response_body, expires_at) VALUES ('sk:cred_race', ?, ?, ?, 0, '', ?)`)
    .bind(ROUTE, key, await sha256Hex(BODY), Date.now() + 30_000).run();
const releaseRow = (key: string) => env.DB.prepare(`DELETE FROM idempotency_keys WHERE principal = 'sk:cred_race' AND key = ?`).bind(key).run();
const rowOf = (key: string) => env.DB.prepare(`SELECT status_code FROM idempotency_keys WHERE principal = 'sk:cred_race' AND key = ?`).bind(key).first<{ status_code: number }>();

describe('row vanishes between the reservation INSERT and the SELECT', () => {
  it('re-reserves and runs the handler exactly once, as owner, storing the result', async () => {
    let runs = 0;
    const app = makeApp(async () => (runs++, { status: 201, body: { ok: true } }));
    await reserveRow('vanish-once'); // another request holds the key...
    const db = dbWithHook(async () => void (await releaseRow('vanish-once'))); // ...and releases it just before our SELECT
    const res = await request(app, 'vanish-once', db);
    expect(res.status).toBe(201);
    expect(runs).toBe(1);
    expect(await rowOf('vanish-once')).toEqual({ status_code: 201 });
    // A later duplicate replays instead of running again.
    const again = await request(app, 'vanish-once');
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(runs).toBe(1);
  });

  it('never runs the handler when the reservation cannot be obtained (retryable conflict)', async () => {
    let runs = 0;
    const app = makeApp(async () => (runs++, { status: 201, body: {} }));
    await reserveRow('vanish-twice');
    let reads = 0;
    // Each read finds the row gone, but a competitor re-takes the key right after the first one, so our second INSERT is ignored too.
    const db = dbWithHook(
      async () => void (await releaseRow('vanish-twice')),
      async () => {
        if (++reads === 1) await reserveRow('vanish-twice');
      },
    );
    const res = await request(app, 'vanish-twice', db);
    expect(res.status).toBe(409);
    const err = ((await res.json()) as { error: { code: string; retryable: boolean } }).error;
    expect(err).toMatchObject({ code: 'idempotency_conflict', retryable: true });
    expect(runs).toBe(0);
  });
});

describe('concurrent duplicates', () => {
  it('runs the handler once; the duplicate gets a retryable conflict, then replays after completion', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const app = makeApp(async () => {
      runs++;
      started();
      await gate;
      return { status: 201, body: { n: runs } };
    });
    const first = request(app, 'concurrent');
    await running; // the first request owns the reservation and is inside the handler
    const dup = await request(app, 'concurrent');
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { retryable: boolean } }).error.retryable).toBe(true);
    expect(runs).toBe(1);

    release();
    expect((await first).status).toBe(201);
    const replay = await request(app, 'concurrent');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual({ n: 1 });
    expect(runs).toBe(1);
  });

  it('releases the key when the owner fails, so the next attempt runs the handler', async () => {
    let runs = 0;
    const app = makeApp(async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
      return { status: 201, body: {} };
    });
    expect((await request(app, 'fails-once')).status).toBe(500);
    expect(await rowOf('fails-once')).toBeNull();
    expect((await request(app, 'fails-once')).status).toBe(201);
    expect(runs).toBe(2);
  });
});
