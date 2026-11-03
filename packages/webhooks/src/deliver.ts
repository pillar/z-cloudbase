// Webhook delivery (PRD §21.6): claim a due delivery, sign and POST the stored payload (Standard
// Webhooks), record the attempt, and schedule the retry or give up. Used by every worker that emits
// events (first attempt via waitUntil) and by the consumer's 15-minute cron (retries).
import {
  WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT, WEBHOOK_LEASE_S, WEBHOOK_RESPONSE_SNIPPET_MAX, WEBHOOK_RETENTION_DAYS,
  WEBHOOK_RETRIES_PER_TICK, WEBHOOK_TEST_EVENT, WEBHOOK_TIMEOUT_MS, isEnvironment, newId, webhookBackoffS,
  type WebhookAttempt,
} from '@z-cloudbase/contracts';
import { checkWebhookUrl, webhookHeaders } from '@z-cloudbase/security';
import type { Db } from './db.ts';
import type { ProductEnvTarget, SqlStatement } from './outbox.ts';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface DeliverOptions {
  /** Outbound fetch; tests pass a fake. Defaults to the global fetch. */
  fetch?: Fetcher;
  now?: () => number;
}

export const USER_AGENT = 'z-cloudbase-webhooks/1';
/** Parallel attempts per run (Workers allow six simultaneous outbound connections). */
const CONCURRENCY = 6;

type Outcome = 'delivered' | 'retry' | 'failed' | 'cancelled' | 'skipped';

export interface AttemptResult {
  outcome: Outcome;
  attempt?: WebhookAttempt;
}

async function readSnippet(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < WEBHOOK_RESPONSE_SNIPPET_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A broken body still leaves the status code.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text ? text.slice(0, WEBHOOK_RESPONSE_SNIPPET_MAX) : null;
}

interface Send {
  statusCode: number | null;
  error: string | null;
  snippet: string | null;
  latencyMs: number;
}

async function post(fetchFn: Fetcher, url: string, headers: Record<string, string>, body: string): Promise<Send> {
  const started = Date.now();
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const snippet = await readSnippet(res);
    const ok = res.status >= 200 && res.status < 300;
    const error = ok ? null : res.status >= 300 && res.status < 400 ? 'redirect_not_followed' : `http_${res.status}`;
    return { statusCode: res.status, error, snippet, latencyMs: Date.now() - started };
  } catch (e) {
    const name = (e as Error)?.name;
    const error = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `network_error: ${String((e as Error)?.message ?? e)}`;
    return { statusCode: null, error: error.slice(0, 200), snippet: null, latencyMs: Date.now() - started };
  }
}

interface Loaded {
  payload: string;
  event_type: string;
  url: string;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: number | null;
  enabled: number;
  env: string;
}

/** One attempt of one delivery, if it is due and this caller wins the claim. */
export async function attemptDelivery(db: Db, messageId: string, endpointId: string, opts: DeliverOptions = {}): Promise<AttemptResult> {
  const now = (opts.now ?? Date.now)();
  // Claim: only one sender wins; a crashed sender's claim lapses after the lease.
  const claim = await db
    .prepare(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
       WHERE message_id = ? AND endpoint_id = ? AND status = 'pending' AND next_attempt_at <= ?
       RETURNING attempts, max_attempts`,
    )
    .bind(now, now + WEBHOOK_LEASE_S * 1000, messageId, endpointId, now)
    .first<{ attempts: number; max_attempts: number }>();
  if (!claim) return { outcome: 'skipped' };

  const row = await db
    .prepare(
      `SELECT m.payload, m.event_type, e.url, e.secret, e.previous_secret, e.previous_secret_expires_at, e.enabled, pe.env
       FROM webhook_messages m JOIN webhook_endpoints e ON e.id = ? JOIN product_environments pe ON pe.id = e.product_env_id
       WHERE m.id = ? AND e.product_env_id = m.product_env_id`,
    )
    .bind(endpointId, messageId)
    .first<Loaded>();
  if (!row || !row.enabled) {
    await db.prepare(`UPDATE webhook_deliveries SET status = 'cancelled' WHERE message_id = ? AND endpoint_id = ?`).bind(messageId, endpointId).run();
    return { outcome: 'cancelled' };
  }

  const problem = isEnvironment(row.env) ? checkWebhookUrl(row.url, row.env) : 'invalid_url';
  let sent: Send;
  if (problem) {
    sent = { statusCode: null, error: `url_rejected: ${problem}`, snippet: null, latencyMs: 0 };
  } else {
    const secrets = [row.secret];
    if (row.previous_secret && (row.previous_secret_expires_at ?? 0) > now) secrets.push(row.previous_secret);
    const headers = await webhookHeaders(secrets, messageId, Math.floor(now / 1000), row.payload);
    sent = await post(opts.fetch ?? ((u, i) => fetch(u, i)), row.url, headers, row.payload);
  }

  const delivered = sent.error === null;
  const outcome: Outcome = delivered ? 'delivered' : claim.attempts >= claim.max_attempts ? 'failed' : 'retry';
  const status = outcome === 'retry' ? 'pending' : outcome;
  const next = outcome === 'retry' ? now + webhookBackoffS(claim.attempts) * 1000 : now;
  const attemptId = newId('wha');
  await db
    .prepare(
      `INSERT INTO webhook_attempts (id, endpoint_id, message_id, event_type, attempt, attempted_at, status_code, latency_ms, error, response_snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(attemptId, endpointId, messageId, row.event_type, claim.attempts, now, sent.statusCode, sent.latencyMs, sent.error, sent.snippet)
    .run();
  await db
    .prepare(`UPDATE webhook_deliveries SET status = ?, next_attempt_at = ? WHERE message_id = ? AND endpoint_id = ?`)
    .bind(status, next, messageId, endpointId)
    .run();
  return {
    outcome,
    attempt: {
      id: attemptId, message_id: messageId, event_type: row.event_type, attempt: claim.attempts, attempted_at: now,
      status_code: sent.statusCode, latency_ms: sent.latencyMs, error: sent.error, response_snippet: sent.snippet, delivery_status: status,
    },
  };
}

async function runAll(db: Db, rows: Array<{ message_id: string; endpoint_id: string }>, opts: DeliverOptions): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const r = rows[i++]!;
      try {
        results.push(await attemptDelivery(db, r.message_id, r.endpoint_id, opts));
      } catch (e) {
        // A storage error leaves the claim to lapse; the cron retries after the lease.
        console.error(JSON.stringify({ msg: 'webhook attempt failed', message_id: r.message_id, endpoint_id: r.endpoint_id, error: String(e) }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return results;
}

/** First attempt of freshly recorded messages (the emitting worker calls this inside waitUntil). */
export async function deliverMessages(db: Db, messageIds: string[], opts: DeliverOptions = {}): Promise<AttemptResult[]> {
  if (messageIds.length === 0) return [];
  const results: AttemptResult[] = [];
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < messageIds.length; i += 50) {
    const ids = messageIds.slice(i, i + 50);
    const { results: rows } = await db
      .prepare(`SELECT message_id, endpoint_id FROM webhook_deliveries WHERE status = 'pending' AND message_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ message_id: string; endpoint_id: string }>();
    results.push(...(await runAll(db, rows, opts)));
  }
  return results;
}

/** Due retries (and first attempts the emitter never got to), oldest first; the consumer cron calls this. */
export async function deliverDue(db: Db, opts: DeliverOptions & { limit?: number } = {}): Promise<Record<Outcome, number>> {
  const now = (opts.now ?? Date.now)();
  const { results: rows } = await db
    .prepare(`SELECT message_id, endpoint_id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`)
    .bind(now, opts.limit ?? WEBHOOK_RETRIES_PER_TICK)
    .all<{ message_id: string; endpoint_id: string }>();
  const counts: Record<Outcome, number> = { delivered: 0, retry: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const r of await runAll(db, rows, opts)) counts[r.outcome]++;
  return counts;
}

/** A `webhook.test` message for one endpoint only, attempted once (no retries). */
export function testMessageStatements(target: ProductEnvTarget, endpointId: string, now = Date.now()): { messageId: string; statements: SqlStatement[] } {
  const messageId = newId('msg');
  const payload = JSON.stringify({
    id: messageId, type: WEBHOOK_TEST_EVENT, timestamp: new Date(now).toISOString(), product_id: target.productId, env: target.env,
    data: { webhook_id: endpointId },
  });
  return {
    messageId,
    statements: [
      {
        sql: 'INSERT INTO webhook_messages (id, product_env_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
        binds: [messageId, target.productEnvId, WEBHOOK_TEST_EVENT, payload, now],
      },
      {
        sql: `INSERT INTO webhook_deliveries (message_id, endpoint_id, status, attempts, max_attempts, next_attempt_at, created_at)
              VALUES (?, ?, 'pending', 0, 1, ?, ?)`,
        binds: [messageId, endpointId, now, now],
      },
    ],
  };
}

/** Daily: old messages and deliveries, the attempt log beyond the last N per endpoint, expired previous secrets. */
export async function pruneWebhookData(db: Db, now = Date.now()): Promise<void> {
  const cutoff = now - WEBHOOK_RETENTION_DAYS * 24 * 3600 * 1000;
  await db.prepare('DELETE FROM webhook_deliveries WHERE message_id IN (SELECT id FROM webhook_messages WHERE created_at < ?)').bind(cutoff).run();
  await db.prepare('DELETE FROM webhook_messages WHERE created_at < ?').bind(cutoff).run();
  await db
    .prepare(
      `DELETE FROM webhook_attempts WHERE id IN (
         SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY endpoint_id ORDER BY attempted_at DESC, id DESC) AS rn FROM webhook_attempts)
         WHERE rn > ?)`,
    )
    .bind(WEBHOOK_ATTEMPTS_KEPT_PER_ENDPOINT)
    .run();
  await db
    .prepare('UPDATE webhook_endpoints SET previous_secret = NULL, previous_secret_expires_at = NULL WHERE previous_secret_expires_at <= ?')
    .bind(now)
    .run();
}
