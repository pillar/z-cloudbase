import { ApiError } from '@z-cloudbase/contracts';
import type { ZodType } from 'zod';

/** Validate against a contracts schema; failures become `validation_failed` with per-field details. */
export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new ApiError('validation_failed', 'Invalid request', {
    fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Parse a raw JSON body (text is kept by the caller, e.g. for idempotency hashing). */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('invalid_request', 'Body must be valid JSON');
  }
}
