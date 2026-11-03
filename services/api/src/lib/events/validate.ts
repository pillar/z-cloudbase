import type { EventPropertySchema, PropertySpec } from '@z-cloudbase/contracts';

type Scalar = string | number | boolean | null;

const typeOf = (v: Scalar): 'string' | 'number' | 'boolean' | 'null' => (v === null ? 'null' : (typeof v as 'string' | 'number' | 'boolean'));

function checkValue(name: string, spec: PropertySpec, v: Scalar): string[] {
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  const t = typeOf(v);
  if (!types.includes(t)) return [`${name}: expected ${types.join('|')}, got ${t}`];
  const problems: string[] = [];
  if (typeof v === 'string' && spec.max_length !== undefined && v.length > spec.max_length) problems.push(`${name}: longer than ${spec.max_length}`);
  if (spec.enum && !spec.enum.includes(v as string | number | boolean)) problems.push(`${name}: not one of the allowed values`);
  if (typeof v === 'number') {
    if (spec.minimum !== undefined && v < spec.minimum) problems.push(`${name}: below minimum ${spec.minimum}`);
    if (spec.maximum !== undefined && v > spec.maximum) problems.push(`${name}: above maximum ${spec.maximum}`);
  }
  return problems;
}

/** Field problems of `properties` against a registered schema (PRD §19.11); empty = valid. */
export function validateProperties(schema: EventPropertySchema, properties: Record<string, Scalar>): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(properties, name)) {
      if (spec.required) problems.push(`${name}: required`);
      continue;
    }
    problems.push(...checkValue(name, spec, properties[name]!));
  }
  if (!schema.additional_properties) {
    for (const name of Object.keys(properties)) {
      if (!Object.hasOwn(schema.properties, name)) problems.push(`${name}: not allowed`);
    }
  }
  return problems;
}
