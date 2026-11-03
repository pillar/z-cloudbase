import { describe, expect, it } from 'vitest';
import { challengeFor, createPkcePair, randomToken } from '../src/pkce.ts';

describe('PKCE', () => {
  it('derives the S256 challenge from the RFC 7636 appendix B example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates a verifier within RFC limits (43-128 unreserved chars) that matches its challenge', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await challengeFor(verifier)).toBe(challenge);
  });

  it('never repeats tokens', () => {
    expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50);
  });
});
