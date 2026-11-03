// Mail transports beyond Resend (PRD §21.2), tested at the protocol / binding boundary: the SMTP adapter
// talks to a fake SMTP peer over a real TCP socket (test-node/smtp-peer.ts; plain text, so implicit TLS
// itself is not exercised here), the Cloudflare Email Service adapter to a fake `send_email` binding.
// Neither proves delivery by a real provider (remote-unverified).
import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import {
  cloudflareEmailAdapter, emailAdapterFor, emailTransport, mailAvailable, parseSender, renderEmail, smtpEmailAdapter, unconfiguredEmailAdapter,
} from '../src/email.ts';

const ISSUER = 'https://id.example';
const SITE = { issuer: ISSUER, platformName: 'Acme' };

interface Session {
  lines: string[];
  auth: string | null;
  data: string | null;
}

async function sessions(): Promise<Session[]> {
  return (await fetch(inject('smtpPeer').transcripts)).json<Session[]>();
}

const smtp = (o: { username?: string; password?: string } = { username: 'smtp-user', password: 'smtp-pass' }) =>
  smtpEmailAdapter({ ...SITE, host: '127.0.0.1', port: inject('smtpPeer').port, tls: false, from: 'Acme <no-reply@acme.test>', timeoutMs: 5000, ...o });

/** The session that carried mail for `to` (each send opens one connection). */
async function sessionFor(to: string) {
  const all = await sessions();
  return all.find((s) => s.lines.some((l) => l.includes(`<${to}>`)));
}

describe('SMTP transport (worker-mailer over cloudflare:sockets)', () => {
  it('authenticates, sends one message with the rendered template and closes the session', async () => {
    const to = `smtp-${crypto.randomUUID()}@example.test`;
    await smtp().send({ to, template: 'verify_email', payload: { url: `${ISSUER}/api/auth/verify-email?token=t1` }, lang: 'en' });
    const s = (await sessionFor(to))!;
    expect(s).toBeDefined();
    expect(s.auth).toMatch(/^(plain|login):smtp-user$/);
    expect(s.lines).toContain('MAIL FROM: <no-reply@acme.test>');
    expect(s.lines).toContain(`RCPT TO: <${to}>`);
    expect(s.lines.at(-1)).toBe('QUIT');
    expect(s.data).toContain('Subject: Verify your email address');
    expect(s.data).toMatch(/From: "Acme" <no-reply@acme\.test>/);
    // Body parts are transfer-encoded by the library; the link survives in the text part.
    expect(s.data!.replace(/=\r\n/g, '').replace(/=3D/g, '=')).toContain(`${ISSUER}/api/auth/verify-email?token=t1`);
  });

  it('a rejected recipient fails with the SMTP code only (no address, no server text)', async () => {
    const to = `reject-${crypto.randomUUID()}@example.test`;
    const err = await smtp().send({ to, template: 'reset_password', payload: { url: 'https://x' } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('550');
    expect((err as Error).message).not.toContain(to);
    expect((err as Error).message).not.toContain('unknown user');
  });

  it('wrong credentials fail the session without leaking the password', async () => {
    const err = await smtp({ username: 'smtp-user', password: 'wrong-secret' })
      .send({ to: `auth-${crypto.randomUUID()}@example.test`, template: 'magic_link', payload: { url: 'https://x' } })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('535');
    expect((err as Error).message).not.toContain('wrong-secret');
  });

  it('an unreachable server fails instead of hanging', async () => {
    const mail = smtpEmailAdapter({ ...SITE, host: '127.0.0.1', port: 1, tls: false, from: 'a@acme.test', timeoutMs: 2000 });
    await expect(mail.send({ to: 'u@example.test', template: 'verify_email', payload: {} })).rejects.toThrow(/SMTP/);
  });
});

describe('Cloudflare Email Service transport (send_email binding)', () => {
  it('sends the structured message through the binding', async () => {
    const sent: unknown[] = [];
    const binding = { send: async (m: unknown) => (sent.push(m), { messageId: 'm1' }) } as unknown as SendEmail;
    await cloudflareEmailAdapter({ ...SITE, binding, from: 'Acme <no-reply@acme.test>' }).send({
      to: 'u@example.test', template: 'magic_link', payload: { url: `${ISSUER}/x` }, lang: 'zh',
    });
    expect(sent).toEqual([
      expect.objectContaining({ from: { email: 'no-reply@acme.test', name: 'Acme' }, to: 'u@example.test', subject: '你的登录链接' }),
    ]);
  });

  it('reports the binding error code, not the recipient', async () => {
    const binding = { send: async () => { throw Object.assign(new Error('recipient u@example.test is suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' }); } } as unknown as SendEmail;
    const err = await cloudflareEmailAdapter({ ...SITE, binding, from: 'a@acme.test' })
      .send({ to: 'u@example.test', template: 'verify_email', payload: {} })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('E_RECIPIENT_SUPPRESSED');
    expect((err as Error).message).not.toContain('u@example.test');
  });
});

describe('transport selection (EMAIL_TRANSPORT)', () => {
  const prod = (vars: Record<string, unknown>) => ({ ...env, DEPLOY_ENV: 'production', ...vars }) as unknown as Env;

  it('local development always uses the outbox', () => {
    expect(emailTransport(env)).toBe('outbox');
  });

  it('needs EMAIL_FROM plus the chosen transport settings; Resend is implied by its key (v3.0 deployments)', () => {
    expect(emailTransport(prod({}))).toBeNull();
    expect(mailAvailable(prod({}))).toBe(false);
    expect(emailAdapterFor(prod({}))).toBe(unconfiguredEmailAdapter);
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', RESEND_API_KEY: 're_x' }))).toBe('resend');
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'smtp' }))).toBeNull();
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.acme.test' }))).toBe('smtp');
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'cloudflare' }))).toBeNull();
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'cloudflare', SEND_EMAIL: { send: async () => ({}) } }))).toBe('cloudflare');
    expect(emailTransport(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'carrier-pigeon', RESEND_API_KEY: 're_x' }))).toBeNull();
    expect(emailAdapterFor(prod({ EMAIL_FROM: 'a@acme.test', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.acme.test' }))).not.toBe(unconfiguredEmailAdapter);
  });

  it('parses "Name <address>" senders', () => {
    expect(parseSender('Acme Platform <no-reply@acme.test>')).toEqual({ email: 'no-reply@acme.test', name: 'Acme Platform' });
    expect(parseSender('"Acme" <no-reply@acme.test>')).toEqual({ email: 'no-reply@acme.test', name: 'Acme' });
    expect(parseSender('no-reply@acme.test')).toEqual({ email: 'no-reply@acme.test' });
  });
});

describe('mail templates (PRD §21.2, §21.4)', () => {
  it('render in the message language, falling back to the deployment default', () => {
    const zh = renderEmail({ to: 'u@x', template: 'reset_password', payload: { url: 'https://x' }, lang: 'zh' }, SITE);
    expect(zh.subject).toBe('重置密码');
    expect(zh.text).toContain('Acme');
    expect(zh.html).toContain('lang="zh-CN"');
    expect(renderEmail({ to: 'u@x', template: 'reset_password', payload: {} }, { ...SITE, defaultLang: 'zh' }).subject).toBe('重置密码');
    expect(renderEmail({ to: 'u@x', template: 'reset_password', payload: {} }, SITE).subject).toBe('Reset your password');
  });

  it('every template has both languages', () => {
    for (const template of ['verify_email', 'reset_password', 'existing_account', 'magic_link', 'magic_link_unavailable', 'invitation'] as const) {
      for (const lang of ['zh', 'en'] as const) {
        const r = renderEmail({ to: 'u@x', template, payload: { url: 'https://x/y', days: '7' }, lang }, SITE);
        expect(r.subject.length).toBeGreaterThan(0);
        expect(r.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('applies the validated branding and escapes it', () => {
    const r = renderEmail(
      { to: 'u@x', template: 'magic_link', payload: { url: 'https://id.example/x' } },
      { ...SITE, platformName: 'A<b>', brand: { logoUrl: 'https://cdn.example/logo.png', primaryColor: '#123abc', tagline: null } },
    );
    expect(r.html).toContain('<img src="https://cdn.example/logo.png" alt="A&#60;b&#62;"');
    expect(r.html).toContain('style="color:#123abc"');
    expect(r.html).not.toContain('<b>');
  });
});
