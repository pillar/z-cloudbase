import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// Raw source of every SDK module (Vite inlines this at transform time).
const sources = (import.meta as unknown as {
  glob(p: string, o: { query: string; eager: true; import: string }): Record<string, string>;
}).glob('../src/*.ts', { query: '?raw', eager: true, import: 'default' });

describe('portability', () => {
  it('the SDK source imports no Node built-ins, so it runs in Workers and browsers', () => {
    const entries = Object.entries(sources);
    expect(entries.length).toBeGreaterThan(5);
    for (const [file, text] of entries) {
      const imports = [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^node:/);
        expect(['fs', 'path', 'crypto', 'buffer', 'http', 'https', 'stream', 'os', 'url', 'util']).not.toContain(spec);
      }
      expect(text, file).not.toMatch(/\bBuffer\b|process\.env/);
    }
  });

  it('is marked side-effect free', () => {
    expect(pkg.sideEffects).toBe(false);
  });
});
