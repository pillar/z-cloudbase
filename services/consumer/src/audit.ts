import { newId } from '@z-cloudbase/contracts';

export interface SystemAudit {
  action: string;
  productId?: string | null;
  env?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Append a `system` actor row to the audit stream (same table the api writes; PRD §4.4). */
export function systemAudit(db: D1Database, e: SystemAudit): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, occurred_at, actor_type, actor_id, action, product_id, env, target_type, target_id, metadata)
       VALUES (?, ?, 'system', 'consumer', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId('aud'), Date.now(), e.action, e.productId ?? null, e.env ?? null, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.metadata ?? {}));
}
