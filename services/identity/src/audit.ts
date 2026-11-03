import { newId } from '@z-cloudbase/contracts';

// Same `audit_log` table and row shape as services/api/src/lib/audit.ts; workers do not share code.

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

/** Append to the security audit stream (PRD §4.4, §19.4). Never write secrets or tokens into metadata. */
export async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, occurred_at, actor_type, actor_id, action, product_id, env, target_type, target_id, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('aud'), Date.now(), e.actorType, e.actorId, e.action, e.productId ?? null, e.env ?? null,
      e.targetType ?? null, e.targetId ?? null, e.requestId ?? null, JSON.stringify(e.metadata ?? {}),
    )
    .run();
}
