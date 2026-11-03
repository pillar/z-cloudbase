// Email verification and password reset through the email adapter (PRD §4.2 items 2, 6);
// locally the adapter writes the D1 outbox, which these tests read.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, PASSWORD, auditRows, call, outbox, signIn, signUp, uniqueEmail } from './helpers.ts';
import { refresh, setupClients, ssoToProduct } from './oauth-flow.ts';

async function emailVerified(email: string) {
  const row = await env.DB.prepare('SELECT emailVerified FROM "user" WHERE email = ?').bind(email).first<{ emailVerified: number }>();
  return row?.emailVerified === 1;
}

/** Response as an observer sees it, minus values that differ per request by design. */
async function observable(res: Response) {
  const body = await res.json<Record<string, unknown>>();
  const user = body.user as Record<string, unknown> | undefined;
  return { status: res.status, keys: Object.keys(body).sort(), userKeys: user ? Object.keys(user).sort() : null, token: body.token ?? null };
}

describe('email verification', () => {
  it('sign-up mails a verification link; following it marks the email verified', async () => {
    const email = uniqueEmail('verify');
    const res = await call('/api/auth/sign-up/email', { json: { email, password: PASSWORD, name: 'V' } });
    expect(res.status).toBe(200);
    expect(await emailVerified(email)).toBe(false);

    const [mail] = await outbox(email);
    expect(mail).toMatchObject({ template: 'verify_email' });
    const link = new URL(mail!.payload.url!);
    expect(link.origin).toBe(env.ISSUER);
    const verify = await call(`${link.pathname}${link.search}`);
    expect(verify.status).toBe(302);
    expect(await emailVerified(email)).toBe(true);
  });

  it('sign-up does not reveal whether an email is registered; the owner gets a notice instead', async () => {
    const existing = await signUp(new CookieJar());
    const fresh = await observable(await call('/api/auth/sign-up/email', { json: { email: uniqueEmail(), password: PASSWORD, name: 'X' } }));
    const duplicate = await observable(await call('/api/auth/sign-up/email', { json: { email: existing.email, password: 'another password 1', name: 'X' } }));
    expect(duplicate).toEqual(fresh);
    expect(duplicate.token).toBeNull(); // nobody is signed in by sign-up

    const users = await env.DB.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?').bind(existing.email).first<{ n: number }>();
    expect(users!.n).toBe(1);
    expect((await outbox(existing.email)).map((m) => m.template)).toContain('existing_account');
    // The original password still works; the attempt changed nothing.
    expect(await signIn(new CookieJar(), existing.email)).toBe(existing.userId);
  });

  it('resend answers the same for unknown, unverified and verified addresses', async () => {
    const unverified = await signUp(new CookieJar());
    const verified = await signUp(new CookieJar());
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(verified.userId).run();
    const nobody = uniqueEmail('nobody');
    const answers = [];
    for (const email of [nobody, unverified.email, verified.email]) {
      const res = await call('/api/auth/send-verification-email', { json: { email } });
      answers.push({ status: res.status, body: await res.json() });
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // Only the unverified owner actually gets mail (sign-up + resend).
    expect(await outbox(nobody)).toEqual([]);
    expect((await outbox(unverified.email)).filter((m) => m.template === 'verify_email')).toHaveLength(2);
    expect((await outbox(verified.email)).filter((m) => m.template === 'verify_email')).toHaveLength(1);
  });
});

describe('password reset', () => {
  beforeAll(async () => {
    await setupClients([{ productId: 'product_a', env: 'prod' }]);
  });

  it('answers identically for registered and unknown emails, and mails only the registered one', async () => {
    const { email } = await signUp(new CookieJar());
    const unknown = uniqueEmail('unknown');
    const a = await call('/api/auth/request-password-reset', { json: { email } });
    const b = await call('/api/auth/request-password-reset', { json: { email: unknown } });
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
    expect((await outbox(email)).map((m) => m.template)).toContain('reset_password');
    expect(await outbox(unknown)).toEqual([]);
  });

  it('the mailed link resets the password, signs out every session and revokes product refresh tokens', async () => {
    const jar = new CookieJar();
    const { email, userId } = await signUp(jar);
    const product = await ssoToProduct(jar, 'product_a');
    await call('/api/auth/request-password-reset', { json: { email, redirectTo: '/reset-password' } });

    const mail = (await outbox(email)).find((m) => m.template === 'reset_password')!;
    const link = new URL(mail.payload.url!);
    const landing = await call(`${link.pathname}${link.search}`);
    expect(landing.status).toBe(302);
    const token = new URL(landing.headers.get('location')!, env.ISSUER).searchParams.get('token')!;
    expect(token).toBeTruthy();

    const newPassword = 'a brand new passphrase';
    const reset = await call('/api/auth/reset-password', { json: { token, newPassword } });
    expect(reset.status).toBe(200);

    expect(await (await call('/api/auth/get-session', { jar })).json()).toBeNull(); // old session revoked
    expect((await refresh('product_a', 'prod', product.refresh_token!)).status).toBe(400);
    expect((await call('/api/auth/sign-in/email', { json: { email, password: PASSWORD } })).status).toBe(401);
    expect(await signIn(new CookieJar(), email, newPassword)).toBe(userId);
    expect(await auditRows('auth.password_reset', userId)).toEqual([expect.objectContaining({ actor_type: 'user', actor_id: userId })]);

    // The token is single-use.
    expect((await call('/api/auth/reset-password', { json: { token, newPassword: 'yet another passphrase' } })).status).toBe(400);
  });
});
