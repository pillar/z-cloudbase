import { ApiError, isEnvironment, type Environment } from '@z-cloudbase/contracts';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../../context.ts';
import { auditStatement, type AuditEntry } from '../../lib/audit.ts';

export type C = Context<AppEnv>;

function validationError(error: z.ZodError): ApiError {
  return new ApiError('validation_failed', 'Request validation failed', {
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export async function readJson<S extends z.ZodType>(c: C, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError('invalid_request', 'Body must be valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function readQuery<S extends z.ZodType>(c: C, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function parseEnv(value: string | undefined): Environment {
  if (!isEnvironment(value)) throw new ApiError('validation_failed', 'env must be dev, staging or prod');
  return value;
}

/** Audit statement for the calling admin; batch it with the mutation so both commit or neither does. */
export function adminAudit(c: C, e: Omit<AuditEntry, 'actorType' | 'actorId' | 'requestId'>): D1PreparedStatement {
  return auditStatement(c.env.DB, { actorType: 'user', actorId: c.get('admin').userId, requestId: c.get('requestId'), ...e });
}

export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

export interface ProductRow {
  id: string;
  name: string;
  status: string;
  visibility: string;
  redirect_uris: string;
  allowed_origins: string;
  created_at: number;
  updated_at: number;
}

export async function loadProduct(c: C, productId: string): Promise<ProductRow> {
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<ProductRow>();
  if (!row) throw new ApiError('not_found', 'Product not found');
  return row;
}

/** `{product_id}.{env}` row of an existing product; call only after authorization. */
export async function loadEnvId(c: C, productId: string, env: Environment): Promise<string> {
  const row = await c.env.DB.prepare('SELECT id FROM product_environments WHERE product_id = ? AND env = ?')
    .bind(productId, env)
    .first<{ id: string }>();
  if (!row) throw new ApiError('not_found', 'Product environment not found');
  return row.id;
}
