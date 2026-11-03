import { REDACTED, SENSITIVE_KEY_RE } from '@z-cloudbase/contracts';

/** Replace values under sensitive-looking keys, recursively (PRD §19.6). Returns a new value. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redact(v);
    return out as T;
  }
  return value;
}
