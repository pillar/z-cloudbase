// Gate 1 (PRD §19.1): Better Auth on D1 inside workerd — register, login, persisted session.
// Gate 6: built-in password hashing, timed in-test (workerd timing is indicative only).
import { env } from 'cloudflare:workers';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { authOptions } from '../src/auth.ts';
import { CookieJar, PASSWORD, auth, call, signUp, uniqueEmail } from './helpers.ts';

const USR_RE = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('gate 1: Better Auth on D1', () => {
  it('0002_auth.sql matches the engine schema on D1 (no pending engine migrations)', async () => {
    const plan = await getMigrations(authOptions({ db: env.DB, issuer: env.ISSUER, secret: env.AUTH_SECRET, platformName: 'Test' }), { throwOnUnsafe: false });
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });

  it('registers, logs in and persists sessions in D1 with usr_<uuidv7> ids', async () => {
    const jar = new CookieJar();
    const t0 = performance.now();
    const { email, userId } = await signUp(jar);
    const signUpMs = performance.now() - t0;
    expect(userId).toMatch(USR_RE);

    const row = await env.DB.prepare('SELECT id, email, isAnonymous, lastActiveAt, deletedAt FROM "user" WHERE id = ?')
      .bind(userId)
      .first<{ id: string; email: string; isAnonymous: number | null; lastActiveAt: string | null; deletedAt: string | null }>();
    expect(row).toMatchObject({ id: userId, email, deletedAt: null });
    expect(row!.isAnonymous ?? 0).toBe(0);
    expect(row!.lastActiveAt).not.toBeNull();

    // Login from a fresh browser.
    const jar2 = new CookieJar();
    const t1 = performance.now();
    const login = await call('/api/auth/sign-in/email', { jar: jar2, json: { email, password: PASSWORD } });
    const signInMs = performance.now() - t1;
    expect(login.status).toBe(200);

    const sessions = await env.DB.prepare('SELECT id, expiresAt FROM session WHERE userId = ?').bind(userId).all<{ id: string }>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.every((s) => s.id.startsWith('ses_'))).toBe(true);

    // The session cookie alone resolves the user on a later request.
    const me = await call('/api/auth/get-session', { jar: jar2 });
    expect(me.status).toBe(200);
    expect((await me.json<{ user: { id: string } }>()).user.id).toBe(userId);

    // Wrong password is rejected.
    const bad = await call('/api/auth/sign-in/email', { json: { email, password: 'not the password' } });
    expect(bad.status).toBe(401);

    console.log(`[gate6] sign-up ${signUpMs.toFixed(0)} ms, sign-in ${signInMs.toFixed(0)} ms (workerd wall time, indicative)`);
  });

  it('issues an HttpOnly, Secure, SameSite=Lax session cookie valid for 7 days', async () => {
    const email = uniqueEmail();
    await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: 'C' } });
    const res = await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Secure-better-auth.session_token='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=604800/i);
  });
});

describe('gate 6: password hashing', () => {
  it('stores an engine (scrypt) hash, never the plaintext', async () => {
    const jar = new CookieJar();
    const { userId } = await signUp(jar);
    const acc = await env.DB.prepare(`SELECT password FROM account WHERE userId = ? AND providerId = 'credential'`)
      .bind(userId)
      .first<{ password: string }>();
    expect(acc!.password).not.toContain(PASSWORD);
    // Better Auth's scrypt format: `<salt hex>:<key hex>`.
    expect(acc!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('hashes and verifies with the engine implementation in well under the CPU budget (indicative)', async () => {
    const { password } = await auth().$context;
    const hashMs: number[] = [];
    const verifyMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now();
      const hash = await password.hash(PASSWORD);
      hashMs.push(performance.now() - t);
      t = performance.now();
      expect(await password.verify({ hash, password: PASSWORD })).toBe(true);
      verifyMs.push(performance.now() - t);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(`[gate6] scrypt hash median ${median(hashMs).toFixed(1)} ms, verify median ${median(verifyMs).toFixed(1)} ms (n=5)`);
    // Generous ceiling: catches an accidental pure-JS fallback (hundreds of ms), not a benchmark.
    expect(median(hashMs)).toBeLessThan(200);
  });
});
