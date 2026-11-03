// Cron jobs: expiry purge, anonymous reclamation, deletion/export pipeline (PRD §19.5-§19.8).
import { newId, newUserId } from '@z-cloudbase/contracts';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { processDueRequests } from '../src/deletion.ts';
import { DAILY_CRON, STALE_PENDING_UPLOAD_MS, reapStalePendingUploads, reclaimAnonymous } from '../src/cron.ts';
import { seedAuthAccount, seedAuthUser, seedMembership, seedObject, seedProduct } from './helpers.ts';

const DAY = 24 * 3600 * 1000;
const rpc = () => ({
  revokeUserTokens: vi.fn(async (_: { userId: string; productId?: string; reason: string }) => {}),
  deleteUserIdentity: vi.fn(async (_: { userId: string; reason: string }) => {}),
  exportUserIdentity: vi.fn(async ({ userId }: { userId: string }) => ({
    user_id: userId, email: 'u@example.com', email_verified: true, name: 'U', is_anonymous: false, created_at: '2026-01-01T00:00:00Z', providers: ['credential'],
  })),
});
const envWith = (r: ReturnType<typeof rpc>) => ({ ...baseEnv, IDENTITY: r }) as unknown as typeof baseEnv;

async function request(userId: string, over: { kind?: 'delete' | 'export'; scope?: 'account' | 'product'; productId?: string | null; status?: string; dueAt?: number } = {}) {
  const id = newId('del');
  await baseEnv.DB.prepare(
    `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, over.kind ?? 'delete', over.scope ?? 'account', over.productId ?? null, over.status ?? 'pending', Date.now() - 1000, over.dueAt ?? Date.now() - 1000).run();
  return id;
}
const status = async (id: string) =>
  baseEnv.DB.prepare('SELECT status, result_ref, completed_at FROM deletion_requests WHERE id = ?').bind(id).first<{ status: string; result_ref: string | null; completed_at: number | null }>();
const objectRows = async (userId: string) =>
  (await baseEnv.DB.prepare('SELECT id FROM storage_objects WHERE owner_user_id = ?').bind(userId).all()).results.length;
const memberships = async (userId: string) =>
  (await baseEnv.DB.prepare('SELECT product_id, status FROM product_memberships WHERE user_id = ? ORDER BY product_id').bind(userId).all<{ product_id: string; status: string }>()).results;
const audits = async (action: string) =>
  (await baseEnv.DB.prepare('SELECT actor_type, actor_id, target_id, product_id, metadata FROM audit_log WHERE action = ?').bind(action).all<any>()).results;

beforeAll(async () => {
  for (const p of ['cr_a', 'cr_b']) {
    await seedProduct(baseEnv.DB, p, 'prod');
    await seedProduct(baseEnv.DB, p, 'dev');
  }
});

describe('deletion pipeline: product scope', () => {
  it("deletes the user's objects in that product only (R2 + rows), keeps other products and other users", async () => {
    const user = newUserId();
    const other = newUserId();
    // The api has already revoked the membership when the user left (DELETE /v1/me/membership).
    await seedMembership(baseEnv.DB, user, 'cr_a', { status: 'revoked' });
    await seedMembership(baseEnv.DB, user, 'cr_b');
    const inA = [await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' }), await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.dev' })];
    const inB = await seedObject(baseEnv, { userId: user, productEnvId: 'cr_b.prod' });
    const othersInA = await seedObject(baseEnv, { userId: other, productEnvId: 'cr_a.prod' });
    const id = await request(user, { scope: 'product', productId: 'cr_a' });
    const r = rpc();

    expect(await processDueRequests(envWith(r))).toEqual({ completed: 1, failed: 0 });

    expect(await status(id)).toMatchObject({ status: 'completed' });
    for (const o of inA) expect(await baseEnv.STORAGE.get(o.key)).toBeNull();
    expect(await baseEnv.STORAGE.get(inB.key)).not.toBeNull();
    expect(await baseEnv.STORAGE.get(othersInA.key)).not.toBeNull();
    expect(await objectRows(user)).toBe(1);
    expect(await objectRows(other)).toBe(1);
    // The revoked row is removed after cleanup so the user may re-join the open product later.
    expect(await memberships(user)).toEqual([{ product_id: 'cr_b', status: 'active' }]);
    expect(r.deleteUserIdentity).not.toHaveBeenCalled();
    expect(r.revokeUserTokens).not.toHaveBeenCalled();
    const [audit] = (await audits('delete.completed')).filter((a) => a.target_id === user);
    expect(audit).toMatchObject({ actor_type: 'system', product_id: 'cr_a' });
    expect(JSON.parse(audit.metadata)).toMatchObject({ request_id: id, objects_deleted: 2 });
  });
});

describe('deletion pipeline: account scope', () => {
  it('deletes objects of every product, memberships, then the identity; marks completed with a system audit row', async () => {
    const user = newUserId();
    await seedMembership(baseEnv.DB, user, 'cr_a');
    await seedMembership(baseEnv.DB, user, 'cr_b');
    const objs = [await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' }), await seedObject(baseEnv, { userId: user, productEnvId: 'cr_b.prod' })];
    const id = await request(user);
    const r = rpc();

    await processDueRequests(envWith(r));

    expect(await status(id)).toMatchObject({ status: 'completed' });
    expect((await status(id))!.completed_at).not.toBeNull();
    for (const o of objs) expect(await baseEnv.STORAGE.get(o.key)).toBeNull();
    expect(await objectRows(user)).toBe(0);
    expect(await memberships(user)).toEqual([]);
    expect(r.deleteUserIdentity).toHaveBeenCalledTimes(1);
    expect(r.deleteUserIdentity.mock.calls[0]![0].userId).toBe(user);
    expect((await audits('delete.completed')).some((a) => a.target_id === user && a.actor_type === 'system')).toBe(true);
  });

  it('cuts off access before deleting data: all tokens revoked and memberships gone before objects are removed', async () => {
    const user = newUserId();
    await seedMembership(baseEnv.DB, user, 'cr_a');
    const obj = await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' });
    await request(user);
    const r = rpc();
    const seenAtRevoke: { memberships: number; objectPresent: boolean }[] = [];
    r.revokeUserTokens.mockImplementation(async () => {
      seenAtRevoke.push({ memberships: (await memberships(user)).length, objectPresent: (await baseEnv.STORAGE.get(obj.key)) !== null });
    });

    await processDueRequests(envWith(r));

    expect(r.revokeUserTokens).toHaveBeenCalledWith(expect.objectContaining({ userId: user }));
    expect(r.revokeUserTokens.mock.calls[0]![0]).not.toHaveProperty('productId');
    // Revocation is the first step: data is still there when it runs.
    expect(seenAtRevoke).toEqual([{ memberships: 1, objectPresent: true }]);
  });

  it("deletes the user's earlier data exports with the account", async () => {
    const user = newUserId();
    await baseEnv.ARCHIVE.put(`exports/${user}/del_old.json`, '{"identity":{"email":"u@example.com"}}');
    const otherUser = newUserId();
    await baseEnv.ARCHIVE.put(`exports/${otherUser}/del_x.json`, '{}');
    await request(user);

    await processDueRequests(envWith(rpc()));

    expect(await baseEnv.ARCHIVE.get(`exports/${user}/del_old.json`)).toBeNull();
    expect(await baseEnv.ARCHIVE.get(`exports/${otherUser}/del_x.json`)).not.toBeNull();
  });

  it('never runs a request cancelled after the batch was selected', async () => {
    const first = newUserId();
    const second = newUserId();
    await request(first, { dueAt: Date.now() - 2000 });
    const secondId = await request(second, { dueAt: Date.now() - 1000 });
    const r = rpc();
    // While the first request is processed, the user of the second one cancels (identity domain).
    r.deleteUserIdentity.mockImplementation(async ({ userId }) => {
      if (userId === first) await baseEnv.DB.prepare(`UPDATE deletion_requests SET status = 'cancelled' WHERE id = ?`).bind(secondId).run();
    });

    await processDueRequests(envWith(r));

    expect((await status(secondId))!.status).toBe('cancelled');
    expect(r.deleteUserIdentity.mock.calls.map((c) => c[0].userId)).toEqual([first]);
  });

  it('handles more objects than one page', async () => {
    const user = newUserId();
    for (let i = 0; i < 120; i++) await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' });
    await request(user);
    await processDueRequests(envWith(rpc()));
    expect(await objectRows(user)).toBe(0);
  });

  it('skips requests that are not due, cancelled or already completed', async () => {
    const user = newUserId();
    const obj = await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' });
    const future = await request(user, { dueAt: Date.now() + 7 * DAY });
    const cancelled = await request(user, { status: 'cancelled' });
    const done = await request(user, { status: 'completed' });
    const r = rpc();
    expect(await processDueRequests(envWith(r))).toEqual({ completed: 0, failed: 0 });
    expect((await status(future))!.status).toBe('pending');
    expect((await status(cancelled))!.status).toBe('cancelled');
    expect((await status(done))!.status).toBe('completed');
    expect(await baseEnv.STORAGE.get(obj.key)).not.toBeNull();
    expect(r.deleteUserIdentity).not.toHaveBeenCalled();
  });

  it('is idempotent: re-running a completed request does nothing; resuming a crashed (processing) one finishes it', async () => {
    const user = newUserId();
    await seedMembership(baseEnv.DB, user, 'cr_a');
    await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod' });
    const id = await request(user);
    const r = rpc();
    await processDueRequests(envWith(r));
    expect(await processDueRequests(envWith(r))).toEqual({ completed: 0, failed: 0 });
    expect(r.deleteUserIdentity).toHaveBeenCalledTimes(1);

    // Crash simulation: objects already gone, status stuck in processing.
    await baseEnv.DB.prepare(`UPDATE deletion_requests SET status = 'processing', completed_at = NULL WHERE id = ?`).bind(id).run();
    expect(await processDueRequests(envWith(r))).toEqual({ completed: 1, failed: 0 });
    expect((await status(id))!.status).toBe('completed');
    expect(r.deleteUserIdentity).toHaveBeenCalledTimes(2);
  });

  it('marks a request failed with an audit row when the identity step fails, and still processes the others', async () => {
    const bad = newUserId();
    const good = newUserId();
    await seedObject(baseEnv, { userId: good, productEnvId: 'cr_a.prod' });
    const badId = await request(bad, { dueAt: Date.now() - 2000 });
    const goodId = await request(good, { dueAt: Date.now() - 1000 });
    const r = rpc();
    r.deleteUserIdentity.mockImplementation(async ({ userId }) => { if (userId === bad) throw new Error('identity unavailable'); });

    expect(await processDueRequests(envWith(r))).toEqual({ completed: 1, failed: 1 });
    expect((await status(badId))!.status).toBe('failed');
    expect((await status(goodId))!.status).toBe('completed');
    const failed = (await audits('delete.failed')).find((a) => a.target_id === bad);
    expect(failed).toMatchObject({ actor_type: 'system' });
    expect(JSON.parse(failed.metadata).error).toContain('identity unavailable');
    // Failed requests are not retried automatically.
    expect(await processDueRequests(envWith(r))).toEqual({ completed: 0, failed: 0 });
  });
});

describe('export pipeline', () => {
  it('writes identity, memberships and the object list to exports/{user}/{id}.json without deleting anything', async () => {
    const user = newUserId();
    await seedMembership(baseEnv.DB, user, 'cr_a');
    await seedMembership(baseEnv.DB, user, 'cr_b');
    const keep = await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod', filename: 'photo.png' });
    const id = await request(user, { kind: 'export' });
    const r = rpc();

    await processDueRequests(envWith(r));

    const row = (await status(id))!;
    expect(row.status).toBe('completed');
    expect(row.result_ref).toBe(`exports/${user}/${id}.json`);
    const doc = (await (await baseEnv.ARCHIVE.get(row.result_ref!))!.json()) as any;
    expect(doc.identity).toMatchObject({ user_id: user, email: 'u@example.com', providers: ['credential'] });
    expect(doc.memberships.map((m: any) => m.product_id).sort()).toEqual(['cr_a', 'cr_b']);
    expect(doc.storage_objects).toHaveLength(1);
    expect(doc.storage_objects[0]).toMatchObject({ filename: 'photo.png', product_env_id: 'cr_a.prod' });
    expect(JSON.stringify(doc)).not.toContain(keep.key); // internal R2 keys are not exported
    expect(await baseEnv.STORAGE.get(keep.key)).not.toBeNull();
    expect(r.deleteUserIdentity).not.toHaveBeenCalled();
    expect((await audits('export.completed')).some((a) => a.target_id === user)).toBe(true);
  });

  it("a product-scope export contains only that product's data", async () => {
    const user = newUserId();
    await seedMembership(baseEnv.DB, user, 'cr_a');
    await seedMembership(baseEnv.DB, user, 'cr_b');
    await seedObject(baseEnv, { userId: user, productEnvId: 'cr_a.prod', filename: 'a.txt' });
    await seedObject(baseEnv, { userId: user, productEnvId: 'cr_b.prod', filename: 'b.txt' });
    const id = await request(user, { kind: 'export', scope: 'product', productId: 'cr_a' });
    const r = rpc();
    await processDueRequests(envWith(r));
    const doc = (await (await baseEnv.ARCHIVE.get((await status(id))!.result_ref!))!.json()) as any;
    expect(doc.memberships.map((m: any) => m.product_id)).toEqual(['cr_a']);
    expect(doc.storage_objects.map((o: any) => o.filename)).toEqual(['a.txt']);
    expect(doc.identity).toBeUndefined();
    expect(r.exportUserIdentity).not.toHaveBeenCalled();
  });

  it('fails the request when the identity export fails', async () => {
    const user = newUserId();
    const id = await request(user, { kind: 'export' });
    const r = rpc();
    r.exportUserIdentity.mockRejectedValue(new Error('no such user'));
    expect(await processDueRequests(envWith(r))).toEqual({ completed: 0, failed: 1 });
    expect((await status(id))!.status).toBe('failed');
  });
});

describe('anonymous reclamation', () => {
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  const recent = new Date(Date.now() - 2 * DAY).toISOString();
  const requests = async (userId: string) =>
    (await baseEnv.DB.prepare('SELECT kind, scope, status, due_at, product_id FROM deletion_requests WHERE user_id = ?').bind(userId).all<any>()).results;

  it('queues account deletion only for anonymous, never-linked users inactive for 30+ days (once)', async () => {
    const stale = newUserId();
    const staleNoActivity = newUserId();
    const active = newUserId();
    const linked = newUserId();
    const registered = newUserId();
    const tombstone = newUserId();
    await seedAuthUser(baseEnv.DB, { id: stale, anonymous: true, lastActiveAt: old });
    await seedAuthUser(baseEnv.DB, { id: staleNoActivity, anonymous: true, lastActiveAt: null, createdAt: old });
    await seedAuthUser(baseEnv.DB, { id: active, anonymous: true, lastActiveAt: recent });
    await seedAuthUser(baseEnv.DB, { id: linked, anonymous: true, lastActiveAt: old });
    await seedAuthAccount(baseEnv.DB, linked);
    await seedAuthUser(baseEnv.DB, { id: registered, anonymous: false, lastActiveAt: old });
    await seedAuthUser(baseEnv.DB, { id: tombstone, anonymous: true, lastActiveAt: old, deletedAt: old });

    const before = Date.now();
    await reclaimAnonymous(baseEnv);
    await reclaimAnonymous(baseEnv); // second run must not duplicate

    for (const id of [stale, staleNoActivity]) {
      const rs = await requests(id);
      expect(rs).toHaveLength(1);
      expect(rs[0]).toMatchObject({ kind: 'delete', scope: 'account', status: 'pending', product_id: null });
      expect(rs[0].due_at).toBeGreaterThanOrEqual(before - 1000);
      expect(rs[0].due_at).toBeLessThanOrEqual(Date.now());
    }
    for (const id of [active, linked, registered, tombstone]) expect(await requests(id)).toEqual([]);
    expect((await audits('anonymous.reclaim_requested')).some((a) => a.target_id === stale && a.actor_type === 'system')).toBe(true);
  });
});

describe('stale pending uploads', () => {
  async function pending(o: { createdAt: number; withBytes: boolean; status?: string }) {
    const id = newId('obj');
    const key = `cr_a/prod/files/u/${id}`;
    if (o.withBytes) await baseEnv.STORAGE.put(key, 'partial');
    await baseEnv.DB.prepare(
      `INSERT INTO storage_objects (id, product_env_id, bucket, owner_user_id, object_key, filename, content_type, size, status, created_at) VALUES (?, 'cr_a.prod', 'files', 'usr_u', ?, 'f.txt', 'text/plain', 7, ?, ?)`,
    ).bind(id, key, o.status ?? 'pending', o.createdAt).run();
    return { id, key };
  }
  const row = (id: string) => baseEnv.DB.prepare('SELECT status FROM storage_objects WHERE id = ?').bind(id).first();

  it('deletes uploads pending longer than the URL TTL + 1h (R2 object if present, row) with a system audit row; keeps the rest', async () => {
    const now = Date.now();
    const old = now - STALE_PENDING_UPLOAD_MS - 1000;
    const staleWithBytes = await pending({ createdAt: old, withBytes: true });
    const staleNoBytes = await pending({ createdAt: old, withBytes: false });
    const recent = await pending({ createdAt: now - STALE_PENDING_UPLOAD_MS + 60_000, withBytes: true });
    const available = await pending({ createdAt: old, withBytes: true, status: 'available' });

    expect(await reapStalePendingUploads(baseEnv, now)).toBe(2);

    expect(await row(staleWithBytes.id)).toBeNull();
    expect(await row(staleNoBytes.id)).toBeNull();
    expect(await baseEnv.STORAGE.head(staleWithBytes.key)).toBeNull();
    expect(await row(recent.id)).toEqual({ status: 'pending' });
    expect(await baseEnv.STORAGE.head(recent.key)).not.toBeNull();
    expect(await row(available.id)).toEqual({ status: 'available' });
    expect(await baseEnv.STORAGE.head(available.key)).not.toBeNull();

    const rows = (await audits('storage.pending_upload.reaped')).filter((a: any) => [staleWithBytes.id, staleNoBytes.id].includes(a.target_id));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: 'consumer', product_id: 'cr_a' });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ bucket: 'files', owner_user_id: 'usr_u' });
    expect(await reapStalePendingUploads(baseEnv, now)).toBe(0);
  });

  it('runs on the 15-minute tick', async () => {
    const stale = await pending({ createdAt: Date.now() - STALE_PENDING_UPLOAD_MS - 1000, withBytes: true });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: '*/15 * * * *' }), envWith(rpc()), ctx);
    await waitOnExecutionContext(ctx);
    expect(await row(stale.id)).toBeNull();
  });
});

describe('scheduled handler', () => {
  const run = async (cron: string, env = baseEnv) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron }), env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it('every 15 minutes: purges expired dedupe rows, idempotency keys, finished auth rate windows and expired export links, keeps live ones, and runs due requests', async () => {
    const now = Date.now();
    await baseEnv.INGEST_DB.batch([
      baseEnv.INGEST_DB.prepare('INSERT INTO event_dedup (product_env_id, event_id, expires_at) VALUES (?, ?, ?)').bind('cr_a.prod', 'expired', now - 1000),
      baseEnv.INGEST_DB.prepare('INSERT INTO event_dedup (product_env_id, event_id, expires_at) VALUES (?, ?, ?)').bind('cr_a.prod', 'live', now + DAY),
    ]);
    const idem = (key: string, expiresAt: number) =>
      baseEnv.DB.prepare(`INSERT INTO idempotency_keys (principal, route, key, request_hash, status_code, response_body, expires_at) VALUES ('p', 'r', ?, 'h', 200, '{}', ?)`).bind(key, expiresAt);
    await baseEnv.DB.batch([idem('expired', now - 1000), idem('live', now + DAY)]);
    const window = now - (now % 60_000);
    await baseEnv.DB.batch([window - 10 * 60_000, window - 60_000, window].map((w, i) =>
      baseEnv.DB.prepare('INSERT INTO auth_rate_counters (key, window_start, count) VALUES (?, ?, 1)').bind(`ip:cron-${i}`, w)));
    const user = newUserId();
    const id = await request(user);
    const link = (hash: string, expiresAt: number) =>
      baseEnv.DB.prepare('INSERT INTO export_links (token_hash, request_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(hash, id, user, now, expiresAt);
    await baseEnv.DB.batch([link('link-expired', now - 1000), link('link-live', now + 15 * 60_000)]);
    const r = rpc();

    await run('*/15 * * * *', envWith(r));

    const dedupe = (await baseEnv.INGEST_DB.prepare('SELECT event_id FROM event_dedup WHERE product_env_id = ?').bind('cr_a.prod').all<{ event_id: string }>()).results;
    expect(dedupe.map((d) => d.event_id)).toEqual(['live']);
    const keys = (await baseEnv.DB.prepare('SELECT key FROM idempotency_keys').all<{ key: string }>()).results;
    expect(keys.map((k) => k.key)).toEqual(['live']);
    // Auth rate windows: the finished one goes, the previous and the current one stay.
    const windows = (await baseEnv.DB.prepare("SELECT key FROM auth_rate_counters WHERE key LIKE 'ip:cron-%' ORDER BY key").all<{ key: string }>()).results;
    expect(windows.map((w) => w.key)).toEqual(['ip:cron-1', 'ip:cron-2']);
    const links = (await baseEnv.DB.prepare("SELECT token_hash FROM export_links WHERE token_hash LIKE 'link-%'").all<{ token_hash: string }>()).results;
    expect(links.map((l) => l.token_hash)).toEqual(['link-live']);
    expect((await status(id))!.status).toBe('completed');
  });

  it('daily: reclaims stale anonymous users and processes the resulting deletion; the 15-minute tick does not reclaim', async () => {
    const stale = newUserId();
    await seedAuthUser(baseEnv.DB, { id: stale, anonymous: true, lastActiveAt: new Date(Date.now() - 40 * DAY).toISOString() });
    const r = rpc();

    await run('*/15 * * * *', envWith(r));
    expect(r.deleteUserIdentity).not.toHaveBeenCalled();

    await run(DAILY_CRON, envWith(r));
    expect(r.deleteUserIdentity).toHaveBeenCalledWith(expect.objectContaining({ userId: stale }));
  });

  it('does not reclaim an anonymous user who keeps using a product through token refreshes', async () => {
    const active = newUserId();
    await seedAuthUser(baseEnv.DB, { id: active, anonymous: true, lastActiveAt: new Date(Date.now() - 40 * DAY).toISOString() });
    await seedMembership(baseEnv.DB, active, 'cr_a', { lastSeenAt: Date.now() - DAY });

    await reclaimAnonymous(baseEnv);

    const req = await baseEnv.DB.prepare('SELECT 1 FROM deletion_requests WHERE user_id = ?').bind(active).first();
    expect(req).toBeNull();
  });

  it('prunes substitute events older than the query window on the daily run', async () => {
    const insert = (id: string, at: number) =>
      baseEnv.INGEST_DB.prepare('INSERT INTO events_substitute (product_env_id, event_id, event_name, occurred_at, received_at) VALUES (?, ?, ?, ?, ?)').bind('cr_a.prod', id, 'x', at, at);
    await baseEnv.INGEST_DB.batch([insert('ancient', Date.now() - 100 * DAY), insert('fresh', Date.now() - DAY)]);
    await run(DAILY_CRON, envWith(rpc()));
    const left = (await baseEnv.INGEST_DB.prepare('SELECT event_id FROM events_substitute WHERE product_env_id = ?').bind('cr_a.prod').all<{ event_id: string }>()).results;
    expect(left.map((l) => l.event_id)).toEqual(['fresh']);
  });
});
