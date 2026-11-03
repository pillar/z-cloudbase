// Webhook delivery on the consumer (PRD §21.6) and the cron parts of PRD §21.5: retries with exponential
// backoff and give-up, single delivery under concurrent senders, the URL guard at send time, disabled
// endpoints, user.deleted from the deletion pipeline (scoped to the right products), expired bans,
// expired impersonations (session and its tokens removed) and log pruning.
import { WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT, WEBHOOK_MAX_ATTEMPTS, newId, newUserId, webhookBackoffS } from '@z-cloudbase/contracts';
import { verifyWebhookSignature } from '@z-cloudbase/security';
import { outboxStatements } from '@z-cloudbase/webhooks';
import { env as baseEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDueRequests } from '../src/deletion.ts';
import { expireBans, expireImpersonations, prepareAll, pruneWebhooks, retryWebhooks, setWebhookFetch } from '../src/user-admin.ts';
import { seedAuthUser, seedMembership, seedProduct } from './helpers.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const db = baseEnv.DB;
const sent: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
let status = 200;

beforeAll(async () => {
  for (const p of ['wh_a', 'wh_b']) for (const e of ['prod', 'dev']) await seedProduct(db, p, e);
  setWebhookFetch(async (url, init) => {
    const body = String(init.body);
    const headers = new Headers(init.headers);
    // Tests move the clock forward; check the signature against the attempt's own timestamp.
    await verifyWebhookSignature({ secret: SECRET, headers, body, now: Number(headers.get('webhook-timestamp')) * 1000 });
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(body) });
    return new Response(status === 200 ? 'ok' : 'nope', { status });
  });
});
afterAll(() => setWebhookFetch(null));
beforeEach(() => {
  sent.length = 0;
  status = 200;
});

async function endpoint(productEnvId: string, types: string[], url = 'https://hooks.example.com/in') {
  const id = newId('whe');
  await db.prepare(
    `INSERT INTO webhook_endpoints (id, product_env_id, url, event_types, enabled, secret, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'usr_x', ?, ?)`,
  ).bind(id, productEnvId, url, JSON.stringify(types), SECRET, Date.now(), Date.now()).run();
  return id;
}

async function emit(productEnvId: string, userId: string, now = Date.now()) {
  const [productId, envName] = productEnvId.split('.') as [string, 'prod' | 'dev'];
  const o = outboxStatements({ target: { productEnvId, productId, env: envName }, type: 'user.banned', data: { user_id: userId, expires_at: null }, now });
  await db.batch(prepareAll(db, o.statements));
  return o.messageId;
}

const delivery = (messageId: string, endpointId: string) =>
  db.prepare('SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE message_id = ? AND endpoint_id = ?')
    .bind(messageId, endpointId).first<{ status: string; attempts: number; next_attempt_at: number }>();

describe('delivery and retries', () => {
  it('retries with 15 min × 2^(n−1) backoff (max 12 h) and gives up after 8 attempts, logging each one', async () => {
    const ep = await endpoint('wh_a.prod', ['user.banned']);
    let now = Date.now();
    const msg = await emit('wh_a.prod', 'usr_r1', now);
    status = 503;
    for (let n = 1; n <= WEBHOOK_MAX_ATTEMPTS; n++) {
      const counts = await retryWebhooks(baseEnv, now);
      expect(counts[n === WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'retry']).toBe(1);
      const d = (await delivery(msg, ep))!;
      expect(d.attempts).toBe(n);
      if (n < WEBHOOK_MAX_ATTEMPTS) {
        expect(d).toMatchObject({ status: 'pending', next_attempt_at: now + webhookBackoffS(n) * 1000 });
        // Not due yet: nothing happens a minute before.
        expect((await retryWebhooks(baseEnv, d.next_attempt_at - 60_000)).retry).toBe(0);
        now = d.next_attempt_at;
      } else {
        expect(d.status).toBe('failed');
      }
    }
    expect(sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(new Set(sent.map((s) => s.headers.get('webhook-id')))).toEqual(new Set([msg]));
    const log = await db.prepare('SELECT attempt, status_code, error FROM webhook_attempts WHERE message_id = ? ORDER BY attempt').bind(msg).all();
    expect(log.results).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(log.results[0]).toEqual({ attempt: 1, status_code: 503, error: 'http_503' });
    expect((await retryWebhooks(baseEnv, now + 30 * 86_400_000)).failed).toBe(0);
  });

  it('a delivery is sent once even with concurrent senders, and succeeds on a later attempt', async () => {
    const ep = await endpoint('wh_a.dev', ['user.banned'], 'http://localhost:9/hook');
    const msg = await emit('wh_a.dev', 'usr_r2');
    status = 500;
    const now = Date.now();
    await Promise.all([retryWebhooks(baseEnv, now), retryWebhooks(baseEnv, now), retryWebhooks(baseEnv, now)]);
    expect(sent.filter((s) => s.headers.get('webhook-id') === msg)).toHaveLength(1);
    status = 200;
    await retryWebhooks(baseEnv, (await delivery(msg, ep))!.next_attempt_at);
    expect(await delivery(msg, ep)).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('checks the URL again at send time and skips disabled endpoints', async () => {
    const bad = await endpoint('wh_b.prod', ['user.banned']);
    const off = await endpoint('wh_b.prod', ['user.banned']);
    const msg = await emit('wh_b.prod', 'usr_r3');
    await db.prepare(`UPDATE webhook_endpoints SET url = 'https://10.0.0.5/hook' WHERE id = ?`).bind(bad).run();
    await db.prepare('UPDATE webhook_endpoints SET enabled = 0 WHERE id = ?').bind(off).run();
    await retryWebhooks(baseEnv);
    expect(sent.filter((s) => s.headers.get('webhook-id') === msg)).toHaveLength(0);
    const a = await db.prepare('SELECT error FROM webhook_attempts WHERE endpoint_id = ?').bind(bad).first<{ error: string }>();
    expect(a!.error).toBe('url_rejected: private_address');
    expect((await delivery(msg, off))!.status).toBe('cancelled');
  });

  it('records nothing when no enabled endpoint subscribes to the type', async () => {
    await endpoint('wh_b.dev', ['user.joined']);
    await emit('wh_b.dev', 'usr_r4');
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM webhook_messages WHERE product_env_id = 'wh_b.dev'`).first()).toEqual({ n: 0 });
  });
});

describe('events from the cron jobs', () => {
  const rpc = () => ({
    revokeUserTokens: vi.fn(async () => {}),
    deleteUserIdentity: vi.fn(async () => {}),
    exportUserIdentity: vi.fn(async () => ({})),
  });
  const envWith = (r: ReturnType<typeof rpc>) => ({ ...baseEnv, IDENTITY: r }) as unknown as typeof baseEnv;
  async function seenIn(userId: string, productEnvId: string) {
    await db.prepare('INSERT OR IGNORE INTO product_env_users (product_env_id, user_id, first_seen_at) VALUES (?, ?, ?)').bind(productEnvId, userId, Date.now()).run();
  }
  async function deletion(userId: string, scope: 'account' | 'product', productId: string | null) {
    await db.prepare(
      `INSERT INTO deletion_requests (id, user_id, kind, scope, product_id, status, requested_at, due_at) VALUES (?, ?, 'delete', ?, ?, 'pending', ?, ?)`,
    ).bind(newId('del'), userId, scope, productId, Date.now() - 1000, Date.now() - 1000).run();
  }

  it("user.deleted: product scope only to that product's environments; account scope to every environment the user signed in to", async () => {
    await endpoint('wh_a.prod', ['user.deleted']);
    await endpoint('wh_b.prod', ['user.deleted']);
    const user = newUserId();
    await seedMembership(db, user, 'wh_a', { status: 'revoked' });
    await seedMembership(db, user, 'wh_b');
    await seenIn(user, 'wh_a.prod');
    await seenIn(user, 'wh_b.prod');
    await deletion(user, 'product', 'wh_a');
    await processDueRequests(envWith(rpc()));
    let mine = sent.filter((s) => s.body.data.user_id === user);
    expect(mine.map((s) => [s.body.product_id, s.body.env, s.body.data.scope])).toEqual([['wh_a', 'prod', 'product']]);
    expect(Object.keys(mine[0]!.body).sort()).toEqual(['data', 'env', 'id', 'product_id', 'timestamp', 'type']);
    expect(mine[0]!.body.data).toEqual({ user_id: user, scope: 'product' });
    expect(await db.prepare('SELECT product_env_id FROM product_env_users WHERE user_id = ?').bind(user).all()).toMatchObject({ results: [{ product_env_id: 'wh_b.prod' }] });

    sent.length = 0;
    await deletion(user, 'account', null);
    await processDueRequests(envWith(rpc()));
    mine = sent.filter((s) => s.body.data.user_id === user);
    expect(mine.map((s) => [s.body.product_id, s.body.data.scope])).toEqual([['wh_b', 'account']]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM product_env_users WHERE user_id = ?').bind(user).first()).toEqual({ n: 0 });
  });

  it('expired bans are lifted with a system audit row and user.unbanned (reason expired); running bans stay', async () => {
    await endpoint('wh_b.dev', ['user.unbanned']);
    const [gone, still] = [newUserId(), newUserId()];
    for (const u of [gone, still]) {
      await seedAuthUser(db, { id: u, anonymous: false, lastActiveAt: null });
      await seenIn(u, 'wh_b.dev');
    }
    await db.prepare('UPDATE "user" SET banned = 1, banReason = ?, banExpires = ? WHERE id = ?').bind('x', new Date(Date.now() - 1000).toISOString(), gone).run();
    await db.prepare('UPDATE "user" SET banned = 1, banReason = ?, banExpires = ? WHERE id = ?').bind('x', new Date(Date.now() + 3600_000).toISOString(), still).run();
    expect(await expireBans(baseEnv)).toBe(1);
    expect(await db.prepare('SELECT banned, banReason, banExpires FROM "user" WHERE id = ?').bind(gone).first()).toEqual({ banned: 0, banReason: null, banExpires: null });
    expect((await db.prepare('SELECT banned FROM "user" WHERE id = ?').bind(still).first<{ banned: number }>())!.banned).toBe(1);
    expect(sent.find((s) => s.body.data.user_id === gone)?.body).toMatchObject({ type: 'user.unbanned', product_id: 'wh_b', env: 'dev', data: { reason: 'expired' } });
    const audit = await db.prepare(`SELECT actor_type, metadata FROM audit_log WHERE action = 'user.unban' AND target_id = ?`).bind(gone).first<{ actor_type: string; metadata: string }>();
    expect(audit).toMatchObject({ actor_type: 'system' });
    expect(JSON.parse(audit!.metadata)).toEqual({ reason: 'expired' });
  });

  it('expired impersonations end: session and the product tokens issued in it are deleted; pending requests lapse', async () => {
    const [actor, target] = [newUserId(), newUserId()];
    await seedAuthUser(db, { id: actor, anonymous: false, lastActiveAt: null });
    await seedAuthUser(db, { id: target, anonymous: false, lastActiveAt: null });
    const t = new Date().toISOString();
    const sid = newId('ses');
    await db.prepare(`INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId, impersonatedBy) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(sid, t, newId('tok'), t, t, target, actor).run();
    await db.prepare(`INSERT INTO "oauthClient" (id, clientId, redirectUris) VALUES ('c1', 'wh_a.prod', '[]')`).run().catch(() => undefined);
    await db.prepare(`INSERT INTO "oauthRefreshToken" (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, 'wh_a.prod', ?, ?, ?, ?, '[]')`)
      .bind(newId('rt'), newId('h'), sid, target, t, t).run();
    const imp = newId('imp');
    const now = Date.now();
    await db.prepare(`INSERT INTO impersonations (id, actor_id, target_id, reason, status, created_at, request_expires_at, session_id, started_at, expires_at)
      VALUES (?, ?, ?, 'r', 'active', ?, ?, ?, ?, ?)`).bind(imp, actor, target, now - 7200_000, now - 7000_000, sid, now - 3700_000, now - 100_000).run();
    const pending = newId('imp');
    await db.prepare(`INSERT INTO impersonations (id, actor_id, target_id, reason, status, created_at, request_expires_at) VALUES (?, ?, ?, 'r', 'pending', ?, ?)`)
      .bind(pending, actor, target, now - 3600_000, now - 1).run();

    expect(await expireImpersonations(baseEnv)).toBe(1);
    expect(await db.prepare('SELECT status, end_reason FROM impersonations WHERE id = ?').bind(imp).first()).toEqual({ status: 'ended', end_reason: 'expired' });
    expect(await db.prepare('SELECT status FROM impersonations WHERE id = ?').bind(pending).first()).toEqual({ status: 'cancelled' });
    expect(await db.prepare('SELECT 1 AS x FROM "session" WHERE id = ?').bind(sid).first()).toBeNull();
    expect(await db.prepare('SELECT 1 AS x FROM "oauthRefreshToken" WHERE userId = ?').bind(target).first()).toBeNull();
    const audit = await db.prepare(`SELECT metadata FROM audit_log WHERE action = 'user.impersonation.stop' AND target_id = ?`).bind(target).first<{ metadata: string }>();
    expect(JSON.parse(audit!.metadata)).toEqual({ impersonation_id: imp, actor_id: actor, end_reason: 'expired' });
  });

  it('daily pruning keeps the last attempts per endpoint and drops messages past retention', async () => {
    const ep = await endpoint('wh_a.dev', ['user.banned']);
    const now = Date.now();
    await db.batch(Array.from({ length: WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT + 5 }, (_, i) =>
      db.prepare(`INSERT INTO webhook_attempts (id, endpoint_id, message_id, event_type, attempt, attempted_at, latency_ms) VALUES (?, ?, 'msg_x', 'user.banned', 1, ?, 1)`)
        .bind(newId('wha'), ep, now - i)));
    const old = await emit('wh_a.dev', 'usr_old', now - 31 * 86_400_000);
    await pruneWebhooks(baseEnv, now);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM webhook_attempts WHERE endpoint_id = ?').bind(ep).first()).toEqual({ n: WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT });
    expect(await db.prepare('SELECT 1 AS x FROM webhook_messages WHERE id = ?').bind(old).first()).toBeNull();
  });
});
