import { ApiError, IDEMPOTENCY_KEY_TTL_S } from '@z-cloudbase/contracts';
import { sha256Hex } from '@z-cloudbase/security';
import type { Context } from 'hono';
import type { AppEnv } from '../context.ts';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** A crashed in-flight request frees its key after this long. */
const IN_FLIGHT_S = 60;

interface Row {
  request_hash: string;
  status_code: number;
  response_body: string;
  expires_at: number;
}

/** Scope = (credential, route), PRD §19.5; publishable keys are narrowed to the end user. */
function principalOf(c: Context<AppEnv>): string {
  const cred = c.get('cred');
  return cred.kind === 'service' ? `sk:${cred.credentialId}` : `pk:${cred.productEnvId}:${c.get('user')?.userId ?? '-'}`;
}

/**
 * Run `handler` at most once per Idempotency-Key. Same key + same body replays the stored 2xx
 * response; same key + different body is `idempotency_conflict`. Without the header, just runs.
 * Failed (non-2xx) results are not stored, so the client can fix the request and retry with the same key.
 */
export async function withIdempotency(
  c: Context<AppEnv>,
  route: string,
  rawBody: string,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (key === undefined) {
    const r = await handler();
    return c.json(r.body, r.status as 200);
  }
  if (key.length < 1 || key.length > 255) throw new ApiError('validation_failed', `${IDEMPOTENCY_HEADER} must be 1-255 characters`);

  const db = c.env.DB;
  const principal = principalOf(c);
  const hash = await sha256Hex(rawBody);
  const now = Date.now();

  await db.prepare('DELETE FROM idempotency_keys WHERE principal = ? AND route = ? AND key = ? AND expires_at <= ?')
    .bind(principal, route, key, now).run();
  // Reserve the key before running so a concurrent duplicate cannot execute the handler twice.
  // The handler runs only when this request owns the reservation; if another request's row
  // vanished between our INSERT and SELECT (it failed and released), try to reserve once more.
  for (let attempt = 0; ; attempt++) {
    const reserved = await db
      .prepare(`INSERT OR IGNORE INTO idempotency_keys (principal, route, key, request_hash, status_code, response_body, expires_at) VALUES (?, ?, ?, ?, 0, '', ?)`)
      .bind(principal, route, key, hash, now + IN_FLIGHT_S * 1000).run();
    if (reserved.meta.changes === 1) break;
    const row = await db.prepare('SELECT request_hash, status_code, response_body, expires_at FROM idempotency_keys WHERE principal = ? AND route = ? AND key = ?')
      .bind(principal, route, key).first<Row>();
    if (row) {
      if (row.request_hash !== hash) throw new ApiError('idempotency_conflict', `${IDEMPOTENCY_HEADER} was already used with a different request body`);
      if (row.status_code === 0) throw new ApiError('idempotency_conflict', 'A request with this key is still in progress', undefined, { retryable: true });
      return new Response(row.response_body, { status: row.status_code, headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' } });
    }
    if (attempt >= 1) throw new ApiError('idempotency_conflict', 'A request with this key is still in progress', undefined, { retryable: true });
  }

  const release = () => db.prepare('DELETE FROM idempotency_keys WHERE principal = ? AND route = ? AND key = ?').bind(principal, route, key).run();
  let result: { status: number; body: unknown };
  try {
    result = await handler();
  } catch (e) {
    await release();
    throw e;
  }
  if (result.status < 200 || result.status >= 300) {
    await release();
  } else {
    await db.prepare('UPDATE idempotency_keys SET status_code = ?, response_body = ?, expires_at = ? WHERE principal = ? AND route = ? AND key = ?')
      .bind(result.status, JSON.stringify(result.body), Date.now() + IDEMPOTENCY_KEY_TTL_S * 1000, principal, route, key).run();
  }
  return c.json(result.body, result.status as 200);
}
