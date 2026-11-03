import { newId } from '@z-cloudbase/contracts';
import { platformName } from './platform.ts';

/** Transactional mail sent by the identity domain (PRD §4.2 item 2). */
export type EmailTemplate = 'verify_email' | 'reset_password' | 'existing_account';

export interface EmailMessage {
  to: string;
  template: EmailTemplate;
  /** Template variables, e.g. the verification / reset link. */
  payload: Record<string, string>;
}

/** Provider adapter seam (PRD §19.10): Resend in deployments (D13), the D1 outbox locally. */
export interface EmailAdapter {
  send(message: EmailMessage): Promise<void>;
}

/** Local / test adapter: mail is written to the D1 `email_outbox` table for tests to read. */
export function outboxEmailAdapter(db: D1Database): EmailAdapter {
  return {
    async send(m) {
      await db
        .prepare('INSERT INTO email_outbox (id, to_address, template, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(newId('eml'), m.to, m.template, JSON.stringify(m.payload), Date.now())
        .run();
    },
  };
}

/** A deployment without mail configuration fails loudly instead of silently dropping mail. */
export const unconfiguredEmailAdapter: EmailAdapter = {
  async send() {
    throw new Error('No email provider is configured for this deployment');
  },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The deployment a mail comes from: identity origin (sign-in page for notices) and display name. */
export interface MailSite {
  issuer: string;
  platformName: string;
}

/** Subject and body of each template. */
export function renderEmail(m: EmailMessage, site: MailSite): { subject: string; text: string; html: string } {
  const { issuer, platformName: name } = site;
  const url = m.payload.url ?? '';
  const signIn = `${issuer}/login`;
  const reset = `${issuer}/forgot-password`;
  const body = {
    verify_email: {
      subject: 'Verify your email address',
      lines: [`Confirm this address for your ${name} account:`, url, 'The link expires in 1 hour. If you did not sign up, ignore this email.'],
    },
    reset_password: {
      subject: 'Reset your password',
      lines: [`Choose a new password for your ${name} account:`, url, 'The link expires in 1 hour and works once. If you did not ask for it, ignore this email.'],
    },
    existing_account: {
      subject: 'You already have an account',
      lines: [`Someone tried to sign up with this address, which already has a ${name} account.`, `Sign in: ${signIn}`, `Forgot your password? ${reset}`, 'If this was not you, no action is needed.'],
    },
  }[m.template];
  const linkify = (line: string) => escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return {
    subject: body.subject,
    text: body.lines.join('\n\n'),
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif">${body.lines.map((l) => `<p>${linkify(l)}</p>`).join('')}</body></html>`,
  };
}

export const RESEND_API_URL = 'https://api.resend.com/emails';

/** Resend HTTP API (D13). The API key is a Worker secret; it never appears in errors or logs. */
export function resendEmailAdapter(o: MailSite & { apiKey: string; from: string; fetch?: typeof fetch }): EmailAdapter {
  const doFetch = o.fetch ?? fetch;
  return {
    async send(m) {
      const { subject, text, html } = renderEmail(m, o);
      const res = await doFetch(RESEND_API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: o.from, to: [m.to], subject, text, html }),
      });
      if (!res.ok) throw new Error(`Resend rejected the ${m.template} email: HTTP ${res.status}`);
    },
  };
}

/** Local development uses the outbox; a deployment needs RESEND_API_KEY and EMAIL_FROM. */
export function emailAdapterFor(env: Env): EmailAdapter {
  if ((env.DEPLOY_ENV as string) === 'local') return outboxEmailAdapter(env.DB);
  const from = (env as { EMAIL_FROM?: string }).EMAIL_FROM;
  if (env.RESEND_API_KEY && from) return resendEmailAdapter({ apiKey: env.RESEND_API_KEY, from, issuer: env.ISSUER, platformName: platformName(env) });
  return unconfiguredEmailAdapter;
}
