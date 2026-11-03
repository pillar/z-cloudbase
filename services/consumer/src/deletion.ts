import { systemAudit } from './audit.ts';
import { eraseUserAnalytics } from './analytics-erasure.ts';
import { identity } from './identity.ts';

interface DeletionRequest {
  id: string;
  user_id: string;
  kind: 'delete' | 'export';
  scope: 'account' | 'product';
  product_id: string | null;
}

// D1 allows 100 bound parameters per statement; keep each page well below it.
const PAGE = 50;

/** SQL fragment + binds selecting the user's storage objects, optionally within one product (all its envs). */
function objectScope(r: DeletionRequest): { where: string; binds: unknown[] } {
  return r.scope === 'product'
    ? { where: 'owner_user_id = ? AND product_env_id IN (SELECT id FROM product_environments WHERE product_id = ?)', binds: [r.user_id, r.product_id] }
    : { where: 'owner_user_id = ?', binds: [r.user_id] };
}

/** Delete the user's objects (R2 first, then rows) page by page; safe to re-run after a crash. */
async function deleteObjects(env: Env, r: DeletionRequest): Promise<number> {
  const { where, binds } = objectScope(r);
  let deleted = 0;
  for (;;) {
    const { results } = await env.DB.prepare(`SELECT id, object_key FROM storage_objects WHERE ${where} LIMIT ${PAGE}`)
      .bind(...binds).all<{ id: string; object_key: string }>();
    if (results.length === 0) return deleted;
    await env.STORAGE.delete(results.map((o) => o.object_key));
    await env.DB.batch(results.map((o) => env.DB.prepare('DELETE FROM storage_objects WHERE id = ?').bind(o.id)));
    deleted += results.length;
  }
}

async function runDelete(env: Env, r: DeletionRequest): Promise<{ objects: number; analytics_envs: number }> {
  if (r.scope === 'product') {
    // Leave product: the api already revoked the membership and that product's tokens, so no new
    // objects can appear. After cleanup the revoked row is removed, letting the user re-join an
    // open product later by signing in again (an admin revoke, by contrast, stays in place).
    const objects = await deleteObjects(env, r);
    // Product analytics of the user go with the membership (PRD §21.9); the archive is suppressed for exports.
    const analytics = await eraseUserAnalytics(env, r.user_id, r.product_id);
    await env.DB.prepare(`DELETE FROM product_memberships WHERE user_id = ? AND product_id = ? AND status = 'revoked'`).bind(r.user_id, r.product_id).run();
    return { objects, analytics_envs: analytics.length };
  }
  // Account (PRD §19.8): first stop all access — revoke sessions/tokens, then drop memberships
  // (the api rejects any token without an active membership) — so nothing new can be written
  // while data is deleted. Then objects, export archives, and finally the identity tombstone.
  await identity(env).revokeUserTokens({ userId: r.user_id, reason: `deletion_request:${r.id}` });
  await env.DB.prepare('DELETE FROM product_memberships WHERE user_id = ?').bind(r.user_id).run();
  const objects = await deleteObjects(env, r);
  await deleteExports(env, r.user_id);
  const analytics = await eraseUserAnalytics(env, r.user_id, null);
  await identity(env).deleteUserIdentity({ userId: r.user_id, reason: `deletion_request:${r.id}` });
  return { objects, analytics_envs: analytics.length };
}

/** Previous data exports hold the user's email and name; they go with the account. */
async function deleteExports(env: Env, userId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: `exports/${userId}/`, cursor });
    if (page.objects.length > 0) await env.ARCHIVE.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Export JSON (identity for account scope, memberships, object list) to the private archive path. */
async function runExport(env: Env, r: DeletionRequest): Promise<{ ref: string }> {
  const { where, binds } = objectScope(r);
  const memberships = await env.DB.prepare(
    `SELECT product_id, status, joined_at FROM product_memberships WHERE user_id = ?${r.scope === 'product' ? ' AND product_id = ?' : ''}`,
  ).bind(...(r.scope === 'product' ? [r.user_id, r.product_id] : [r.user_id])).all();
  const objects = await env.DB.prepare(
    `SELECT id, product_env_id, bucket, filename, content_type, size, status, created_at FROM storage_objects WHERE ${where} ORDER BY created_at`,
  ).bind(...binds).all();
  const ref = `exports/${r.user_id}/${r.id}.json`;
  await env.ARCHIVE.put(ref, JSON.stringify({
    generated_at: new Date().toISOString(),
    scope: r.scope,
    product_id: r.product_id,
    identity: r.scope === 'account' ? await identity(env).exportUserIdentity({ userId: r.user_id }) : undefined,
    memberships: memberships.results,
    storage_objects: objects.results,
  }, null, 2));
  return { ref };
}

/**
 * Process due deletion/export requests (PRD §19.8). `pending` → `processing` → `completed`/`failed`.
 * Requests left in `processing` (a crashed run) are picked up again; every step is idempotent.
 * `failed` requests are not retried automatically: an operator resets them to `pending`.
 */
export async function processDueRequests(env: Env, now = Date.now(), limit = 20): Promise<{ completed: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, kind, scope, product_id FROM deletion_requests
     WHERE status IN ('pending','processing') AND due_at <= ? ORDER BY due_at LIMIT ?`,
  ).bind(now, limit).all<DeletionRequest>();

  let completed = 0;
  let failed = 0;
  for (const r of results) {
    // Re-check under the update: a request cancelled after the SELECT must never run.
    const claim = await env.DB.prepare(`UPDATE deletion_requests SET status = 'processing' WHERE id = ? AND status IN ('pending','processing')`).bind(r.id).run();
    if (claim.meta.changes !== 1) continue;
    const audit = { productId: r.product_id, targetType: 'user', targetId: r.user_id };
    try {
      const out = r.kind === 'export' ? await runExport(env, r) : await runDelete(env, r);
      await env.DB.batch([
        env.DB.prepare(`UPDATE deletion_requests SET status = 'completed', completed_at = ?, result_ref = ? WHERE id = ?`)
          .bind(Date.now(), 'ref' in out ? out.ref : null, r.id),
        systemAudit(env.DB, { ...audit, action: `${r.kind}.completed`, metadata: { request_id: r.id, scope: r.scope, ...('objects' in out ? { objects_deleted: out.objects, analytics_envs_erased: out.analytics_envs } : {}) } }),
      ]);
      completed++;
    } catch (err) {
      console.error(JSON.stringify({ msg: 'deletion request failed', request_id: r.id, error: String(err) }));
      await env.DB.batch([
        env.DB.prepare(`UPDATE deletion_requests SET status = 'failed' WHERE id = ?`).bind(r.id),
        systemAudit(env.DB, { ...audit, action: `${r.kind}.failed`, metadata: { request_id: r.id, scope: r.scope, error: String(err).slice(0, 200) } }),
      ]);
      failed++;
    }
  }
  return { completed, failed };
}
