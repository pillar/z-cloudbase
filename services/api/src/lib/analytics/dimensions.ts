import { ApiError, BUILTIN_DIMENSIONS, USER_PROPERTY_KEY_RE, type BuiltinDimension } from '@z-cloudbase/contracts';

// Breakdown / filter dimensions (PRD §21.8) and their storage columns. Only names from this closed set ever
// reach SQL; values are always bound (D1) or escaped (AE, see aeString).

export interface ResolvedDimension {
  /** Public name: a built-in dimension or `prop:<key>`. */
  name: string;
  /** Column in `event_rows`. */
  column: string;
  /** Analytics Engine column. */
  ae: string;
}

const BUILTIN: Record<BuiltinDimension, { column: string; ae: string }> = {
  event_name: { column: 'event_name', ae: 'blob3' },
  path: { column: 'path', ae: 'blob6' },
  browser: { column: 'browser', ae: 'blob7' },
  os: { column: 'os', ae: 'blob8' },
  device: { column: 'device', ae: 'blob9' },
  country: { column: 'country', ae: 'blob10' },
  source: { column: 'source', ae: 'blob11' },
};

export function resolveDimension(name: string, declared: string[]): ResolvedDimension {
  if ((BUILTIN_DIMENSIONS as readonly string[]).includes(name)) return { name, ...BUILTIN[name as BuiltinDimension] };
  if (name.startsWith('prop:')) {
    const key = name.slice(5);
    const i = declared.indexOf(key);
    if (USER_PROPERTY_KEY_RE.test(key) && i >= 0) return { name, column: `dim${i + 1}`, ae: `blob${12 + i}` };
    throw new ApiError('validation_failed', `Property "${key}" is not a declared analytics dimension`);
  }
  throw new ApiError('validation_failed', `Unknown dimension "${name}"`);
}

export interface Filter {
  dim: ResolvedDimension;
  value: string;
}

/** `dim:value`; custom dimensions are `prop:<key>:value`. */
export function parseFilter(raw: string, declared: string[]): Filter {
  const prop = raw.startsWith('prop:');
  const at = raw.indexOf(':', prop ? 5 : 0);
  if (at <= 0) throw new ApiError('validation_failed', 'filter must be dimension:value');
  const value = raw.slice(at + 1);
  if (value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new ApiError('validation_failed', 'filter value is invalid');
  return { dim: resolveDimension(raw.slice(0, at), declared), value };
}

export interface UserPropertyFilter {
  key: string;
  /** Compared with json_extract(): numbers and booleans (1/0) as numbers, everything else as text. */
  value: string | number;
}

export function parseUserPropertyFilter(raw: string): UserPropertyFilter {
  const at = raw.indexOf(':');
  const key = raw.slice(0, at);
  if (at <= 0 || !USER_PROPERTY_KEY_RE.test(key)) throw new ApiError('validation_failed', 'user_property must be key:value');
  const v = raw.slice(at + 1);
  const value = v === 'true' ? 1 : v === 'false' ? 0 : v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  return { key, value };
}

/** EXISTS clause restricting `actorExpr` to users whose property matches (anonymous `?` placeholders, binds in order). */
export function userPropertyClause(productEnvId: string, actorExpr: string, f: UserPropertyFilter): { sql: string; binds: unknown[] } {
  return {
    // f.key matches USER_PROPERTY_KEY_RE, so it is safe inside the JSON path literal.
    sql: `EXISTS (SELECT 1 FROM user_properties up WHERE up.product_env_id = ? AND up.user_key = ${actorExpr}
           AND json_extract(up.properties, '$."${f.key}"') = ?)`,
    binds: [productEnvId, f.value],
  };
}

/** String literal for Analytics Engine SQL. REMOTE-UNVERIFIED: the docs do not specify escaping; ClickHouse rules. */
export const aeString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
