// Auth rate limits in front of the engine (PRD §19.6): per IP 10/min, per account 5/min, on
// sign-in / sign-up / password reset; 429 with the unified error body and Retry-After.
// Counted in D1 (auth_rate_counters), the same code path as deployments. The failures below also
// trigger Turnstile (test/turnstile.test.ts), so the attempts carry the local test token.
import { AUTH_RATE_PER_ACCOUNT_PER_MIN, AUTH_RATE_PER_IP_PER_MIN } from '@z-cloudbase/contracts';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { TURNSTILE_DUMMY_TOKEN } from '../src/turnstile.ts';
import { PASSWORD, call, uniqueEmail } from './helpers.ts';

const solved = { 'cf-turnstile-response': TURNSTILE_DUMMY_TOKEN };

const ip = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID().slice(0, 4)}`;

async function expectRateLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe('60');
  const body = await res.json<{ error: { code: string; retryable: boolean; request_id: string } }>();
  expect(body.error).toMatchObject({ code: 'rate_limited', retryable: true });
  expect(body.error.request_id).toMatch(/^req_/);
}

describe('auth rate limiting', () => {
  it(`allows ${AUTH_RATE_PER_IP_PER_MIN} sign-in attempts per IP per minute, then answers 429`, async () => {
    const headers = { 'cf-connecting-ip': ip(), ...solved };
    for (let i = 0; i < AUTH_RATE_PER_IP_PER_MIN; i++) {
      const res = await call('/api/auth/sign-in/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } });
      expect(res.status).toBe(401); // reaches the engine (unknown user)
    }
    await expectRateLimited(await call('/api/auth/sign-in/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } }));
    // Sign-up and the login form share the per-IP budget.
    await expectRateLimited(await call('/api/auth/sign-up/email', { headers, json: { email: uniqueEmail(), password: PASSWORD, name: 'x' } }));
    await expectRateLimited(await call('/login', { headers, form: { email: uniqueEmail(), password: PASSWORD } }));
    // Another client is unaffected.
    expect((await call('/api/auth/sign-in/email', { json: { email: uniqueEmail(), password: PASSWORD } })).status).toBe(401);
  });

  it('counts concurrent attempts exactly: a burst from one IP gets no more than the limit through', async () => {
    const headers = { 'cf-connecting-ip': ip(), ...solved };
    const burst = await Promise.all(Array.from({ length: AUTH_RATE_PER_IP_PER_MIN + 5 }, () =>
      call('/api/auth/sign-in/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } })));
    const statuses = burst.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(AUTH_RATE_PER_IP_PER_MIN);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('stores only hashed keys: neither the IP nor the email appears in the counters', async () => {
    const email = uniqueEmail('hashed');
    const addr = ip();
    await call('/api/auth/sign-in/email', { headers: { 'cf-connecting-ip': addr, ...solved }, json: { email, password: PASSWORD } });
    const rows = (await env.DB.prepare('SELECT key FROM auth_rate_counters').all<{ key: string }>()).results.map((r) => r.key);
    expect(rows.some((k) => k.includes(addr) || k.includes(email))).toBe(false);
    expect(rows.every((k) => /^(ip|acct):[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it(`allows ${AUTH_RATE_PER_ACCOUNT_PER_MIN} attempts per account per minute across IPs`, async () => {
    const email = uniqueEmail('target');
    for (let i = 0; i < AUTH_RATE_PER_ACCOUNT_PER_MIN; i++) {
      expect((await call('/api/auth/sign-in/email', { headers: solved, json: { email, password: 'guess' + i } })).status).toBe(401);
    }
    await expectRateLimited(await call('/api/auth/sign-in/email', { headers: solved, json: { email: email.toUpperCase(), password: 'guess' } }));
    await expectRateLimited(await call('/api/auth/request-password-reset', { json: { email } }));
    // A different account from the same moment is fine.
    expect((await call('/api/auth/sign-in/email', { json: { email: uniqueEmail(), password: 'guess' } })).status).toBe(401);
  });

  it('limits anonymous-upgrade attempts, which reveal whether an email is registered (409)', async () => {
    const headers = { 'cf-connecting-ip': ip() };
    for (let i = 0; i < AUTH_RATE_PER_IP_PER_MIN; i++) {
      expect((await call('/link/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } })).status).not.toBe(429);
    }
    await expectRateLimited(await call('/link/email', { headers, json: { email: uniqueEmail(), password: PASSWORD } }));
  });

  it('does not limit reads or non-credential endpoints', async () => {
    const headers = { 'cf-connecting-ip': ip() };
    for (let i = 0; i < AUTH_RATE_PER_IP_PER_MIN + 2; i++) {
      expect((await call('/api/auth/get-session', { headers })).status).toBe(200);
      expect((await call('/login', { headers })).status).toBe(200);
    }
  });
});
