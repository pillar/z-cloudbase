import { EventPropertySchema } from '@z-cloudbase/contracts';
import { describe, expect, it } from 'vitest';
import { validateProperties } from '../src/lib/events/validate.ts';

const schema = (properties: Record<string, unknown>, additional_properties = true) => EventPropertySchema.parse({ properties, additional_properties });

describe('validateProperties', () => {
  it('accepts a conforming event and ignores extras by default', () => {
    const s = schema({ plan: { type: 'string', required: true } });
    expect(validateProperties(s, { plan: 'pro', other: 1 })).toEqual([]);
  });

  it('checks scalar types, including type arrays and null', () => {
    const s = schema({ n: { type: 'number' }, m: { type: ['string', 'null'] } });
    expect(validateProperties(s, { n: '1' })).toEqual([expect.stringContaining('n: expected number')]);
    expect(validateProperties(s, { m: null })).toEqual([]);
    expect(validateProperties(s, { m: 'x' })).toEqual([]);
    expect(validateProperties(s, { m: 3 })).toHaveLength(1);
    expect(validateProperties(schema({ n: { type: 'number' } }), { n: null })).toHaveLength(1);
  });

  it('enforces required (a null value still counts as present)', () => {
    const s = schema({ id: { type: ['string', 'null'], required: true } });
    expect(validateProperties(s, {})).toEqual(['id: required']);
    expect(validateProperties(s, { id: null })).toEqual([]);
  });

  it('enforces max_length, enum, minimum and maximum', () => {
    const s = schema({ s: { type: 'string', max_length: 3 }, e: { type: 'string', enum: ['a', 'b'] }, n: { type: 'number', minimum: 1, maximum: 5 } });
    expect(validateProperties(s, { s: 'abc', e: 'a', n: 5 })).toEqual([]);
    expect(validateProperties(s, { s: 'abcd', e: 'c', n: 0 })).toHaveLength(3);
    expect(validateProperties(s, { n: 6 })).toEqual([expect.stringContaining('maximum')]);
  });

  it('rejects unlisted properties only when additional_properties is false', () => {
    const closed = schema({ a: { type: 'string' } }, false);
    expect(validateProperties(closed, { a: 'x', b: 1 })).toEqual(['b: not allowed']);
    expect(validateProperties(schema({ a: { type: 'string' } }), { b: 1 })).toEqual([]);
  });

  it('treats inherited names like "constructor" as absent', () => {
    expect(validateProperties(schema({ constructor: { type: 'string', required: true } }), {})).toEqual(['constructor: required']);
  });
});
