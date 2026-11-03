import { newId } from '@z-cloudbase/contracts';
import type { Context } from 'hono';
import type { AppEnv } from '../context.ts';

export interface AuditEntry {
  actorType: 'user' | 'service' | 'system';
  actorId: string;
  action: string;
  productId?: string | null;
  env?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append to the security/admin audit stream (PRD §4.4). Never write secrets into metadata. */
export function auditStatement(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, occurred_at, actor_type, actor_id, action, product_id, env, target_type, target_id, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('aud'), Date.now(), e.actorType, e.actorId, e.action, e.productId ?? null, e.env ?? null,
      e.targetType ?? null, e.targetId ?? null, e.requestId ?? null, JSON.stringify(e.metadata ?? {}),
    );
}

export async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await auditStatement(db, e).run();
}

/**
 * Audit statement for a request: adds the request id and, when the end user's token came from a support
 * impersonation (`act`), the owner acting for them as `metadata.actor_id` (PRD §21.5.2).
 */
export function requestAuditStatement(c: Context<AppEnv>, e: Omit<AuditEntry, 'requestId'>): D1PreparedStatement {
  const actor = c.get('user')?.actor;
  return auditStatement(c.env.DB, {
    ...e,
    requestId: c.get('requestId'),
    ...(actor ? { metadata: { ...e.metadata, actor_id: actor } } : {}),
  });
}
