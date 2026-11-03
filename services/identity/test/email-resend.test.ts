// Resend adapter (D13): request shape, template rendering and adapter selection; fake fetch only.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { RESEND_API_URL, emailAdapterFor, renderEmail, resendEmailAdapter, unconfiguredEmailAdapter } from '../src/email.ts';

const ISSUER = 'https://id.example';
const SITE = { issuer: ISSUER, platformName: 'Acme' };

function fakeResend(status = 200) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return Response.json(status === 200 ? { id: 'email_1' } : { message: 'nope' }, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('Resend email adapter', () => {
  it('posts one message per email with the API key as bearer, the configured sender and the rendered template', async () => {
    const { calls, fetchFn } = fakeResend();
    const mail = resendEmailAdapter({ apiKey: 're_test', from: 'Acme <no-reply@example.com>', issuer: ISSUER, platformName: 'Acme', fetch: fetchFn });
    await mail.send({ to: 'u@example.com', template: 'verify_email', payload: { url: `${ISSUER}/api/auth/verify-email?token=t1` } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_API_URL);
    expect(calls[0]!.auth).toBe('Bearer re_test');
    expect(calls[0]!.body).toMatchObject({ from: 'Acme <no-reply@example.com>', to: ['u@example.com'], subject: 'Verify your email address' });
    expect(calls[0]!.body.text).toContain(`${ISSUER}/api/auth/verify-email?token=t1`);
    expect(calls[0]!.body.html).toContain(`<a href="${ISSUER}/api/auth/verify-email?token=t1">`);
  });

  it('fails with the HTTP status (and without the key) when Resend rejects the message', async () => {
    const { fetchFn } = fakeResend(403);
    const mail = resendEmailAdapter({ apiKey: 're_secret_value', from: 'a@example.com', issuer: ISSUER, platformName: 'Acme', fetch: fetchFn });
    const err = await mail.send({ to: 'u@example.com', template: 'reset_password', payload: { url: 'https://x' } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).not.toContain('re_secret_value');
  });

  it('renders every template; the existing-account notice links to sign-in and reset, and HTML is escaped', () => {
    const notice = renderEmail({ to: 'u@example.com', template: 'existing_account', payload: {} }, SITE);
    expect(notice.text).toContain(`${ISSUER}/login`);
    expect(notice.text).toContain(`${ISSUER}/forgot-password`);
    const reset = renderEmail({ to: 'u@example.com', template: 'reset_password', payload: { url: 'https://x/?a=1&b=<2>' } }, SITE);
    expect(reset.subject).toBe('Reset your password');
    expect(reset.text).toContain('your Acme account');
    expect(reset.html).not.toContain('<2>');
  });

  it('is selected only with both RESEND_API_KEY and EMAIL_FROM outside local development', () => {
    const staging = { ...env, DEPLOY_ENV: 'staging' } as unknown as Env;
    expect(emailAdapterFor(staging)).toBe(unconfiguredEmailAdapter);
    expect(emailAdapterFor({ ...staging, RESEND_API_KEY: 're_x' } as Env)).toBe(unconfiguredEmailAdapter);
    expect(emailAdapterFor({ ...staging, RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@example.com' } as unknown as Env)).not.toBe(unconfiguredEmailAdapter);
  });
});
