import { describe, expect, it } from 'vitest';
import { validColor, validLogoUrl } from '../src/brand.ts';

describe('branding values (PRD §21.4)', () => {
  it('accepts only https logo URLs without markup characters', () => {
    expect(validLogoUrl('https://cdn.example/logo.svg')).toBe(true);
    for (const bad of [undefined, '', 'http://cdn.example/l.svg', 'javascript:alert(1)', 'https://x/"a', 'https://x/a b', 'data:image/png;base64,AA']) {
      expect(validLogoUrl(bad), String(bad)).toBe(false);
    }
  });

  it('accepts only #rgb / #rrggbb colors', () => {
    expect(validColor('#4f46e5')).toBe(true);
    expect(validColor('#ABC')).toBe(true);
    for (const bad of [undefined, 'red', '#12', '#4f46e5;}', 'rgb(0,0,0)']) expect(validColor(bad), String(bad)).toBe(false);
  });
});
