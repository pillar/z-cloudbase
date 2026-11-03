// Transactional mail of the identity domain (PRD §4.2 item 2, §21.2): templates in both UI languages
// and the transports a deployment can choose (EMAIL_TRANSPORT): Resend's HTTP API, any SMTP server over
// implicit TLS (cloudflare:sockets via worker-mailer), or Cloudflare Email Service (`send_email` binding).
// Local development writes the D1 outbox. A transport never puts the recipient, a secret or the
// server's raw answer into an error message or a log line.
import { newId } from '@z-cloudbase/contracts';
import { LogLevel, WorkerMailer } from 'worker-mailer';
import { defineMessages } from './i18n.ts';
import { platformName } from './platform.ts';
import { brand, defaultLang, magicLinkSetting, type Brand, type Lang } from './settings.ts';

export type EmailTemplate =
  | 'verify_email'
  | 'reset_password'
  | 'existing_account'
  | 'magic_link'
  | 'magic_link_unavailable'
  | 'invitation'
  | 'passkey_added';

export interface EmailMessage {
  to: string;
  template: EmailTemplate;
  /** Template variables, e.g. the verification / reset link. */
  payload: Record<string, string>;
  /** Language of the request that caused the mail (PRD §21.2); the deployment default otherwise. */
  lang?: Lang;
}

/** Provider adapter seam (PRD §19.10): the chosen transport in deployments, the D1 outbox locally. */
export interface EmailAdapter {
  send(message: EmailMessage): Promise<void>;
}

/** Local / test adapter: mail is written to the D1 `email_outbox` table for tests to read (`lang` inside the payload). */
export function outboxEmailAdapter(db: D1Database): EmailAdapter {
  return {
    async send(m) {
      await db
        .prepare('INSERT INTO email_outbox (id, to_address, template, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(newId('eml'), m.to, m.template, JSON.stringify({ ...m.payload, ...(m.lang ? { lang: m.lang } : {}) }), Date.now())
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

// --- templates -----------------------------------------------------------------------------------

const mailMessages = defineMessages({
  zh: {
    verify_subject: '验证你的邮箱地址',
    verify_intro: (name: string) => `请确认这是你的 ${name} 账号的邮箱：`,
    verify_outro: '链接 1 小时内有效。如果你没有注册，请忽略这封邮件。',
    reset_subject: '重置密码',
    reset_intro: (name: string) => `为你的 ${name} 账号设置新密码：`,
    reset_outro: '链接 1 小时内有效，只能使用一次。如果不是你本人申请，请忽略这封邮件。',
    existing_subject: '你已经有账号了',
    existing_intro: (name: string) => `有人尝试用这个邮箱注册，但它已经有一个 ${name} 账号。`,
    existing_signin: (url: string) => `登录：${url}`,
    existing_reset: (url: string) => `忘记密码？${url}`,
    existing_outro: '如果不是你本人操作，无需处理。',
    magic_subject: '你的登录链接',
    magic_intro: (name: string) => `点击下面的链接登录 ${name}：`,
    magic_outro: '链接 5 分钟内有效，只能使用一次。如果不是你本人申请，请忽略这封邮件。',
    magic2fa_subject: '请用密码和验证码登录',
    magic2fa_intro: (name: string) => `有人为你的 ${name} 账号申请了邮件登录链接。你的账号开启了两步验证，因此不能只凭邮件登录。`,
    magic2fa_signin: (url: string) => `请使用密码 + 验证码或 Passkey 登录：${url}`,
    invite_subject: (name: string) => `你受邀加入 ${name}`,
    invite_intro: (name: string) => `你受邀在 ${name} 创建账号。通过下面的链接设置密码：`,
    invite_outro: (days: string) => `链接 ${days} 天内有效，只能使用一次。如果你不认识发件方，请忽略这封邮件。`,
    passkey_subject: '你的账号添加了新的 Passkey',
    passkey_intro: (name: string) => `你的 ${name} 账号刚刚添加了一个新的 Passkey，可以用它登录。`,
    passkey_outro: (url: string) => `如果不是你本人操作，请立即登录账号页删除这个 Passkey 并修改密码：${url}`,
  },
  en: {
    verify_subject: 'Verify your email address',
    verify_intro: (name: string) => `Confirm this address for your ${name} account:`,
    verify_outro: 'The link expires in 1 hour. If you did not sign up, ignore this email.',
    reset_subject: 'Reset your password',
    reset_intro: (name: string) => `Choose a new password for your ${name} account:`,
    reset_outro: 'The link expires in 1 hour and works once. If you did not ask for it, ignore this email.',
    existing_subject: 'You already have an account',
    existing_intro: (name: string) => `Someone tried to sign up with this address, which already has a ${name} account.`,
    existing_signin: (url: string) => `Sign in: ${url}`,
    existing_reset: (url: string) => `Forgot your password? ${url}`,
    existing_outro: 'If this was not you, no action is needed.',
    magic_subject: 'Your sign-in link',
    magic_intro: (name: string) => `Use this link to sign in to ${name}:`,
    magic_outro: 'The link expires in 5 minutes and works once. If you did not ask for it, ignore this email.',
    magic2fa_subject: 'Sign in with your password and code',
    magic2fa_intro: (name: string) =>
      `Someone asked for a sign-in link for your ${name} account. Your account uses two-factor authentication, so email alone cannot sign you in.`,
    magic2fa_signin: (url: string) => `Sign in with your password and code, or a passkey: ${url}`,
    invite_subject: (name: string) => `You are invited to ${name}`,
    invite_intro: (name: string) => `You are invited to create an account on ${name}. Choose your password here:`,
    invite_outro: (days: string) => `The link expires in ${days} days and works once. If you do not know the sender, ignore this email.`,
    passkey_subject: 'A passkey was added to your account',
    passkey_intro: (name: string) => `A new passkey was just added to your ${name} account and can be used to sign in.`,
    passkey_outro: (url: string) => `If this was not you, sign in now, remove the passkey on your account page and change your password: ${url}`,
  },
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The deployment a mail comes from: identity origin (sign-in page for notices), display name and branding. */
export interface MailSite {
  issuer: string;
  platformName: string;
  brand?: Brand;
  defaultLang?: Lang;
}

export function mailSite(env: Env): MailSite {
  return { issuer: env.ISSUER, platformName: platformName(env), brand: brand(env), defaultLang: defaultLang(env) };
}

/** Subject and body of each template, in the message's language. */
export function renderEmail(m: EmailMessage, site: MailSite): { subject: string; text: string; html: string } {
  const { issuer, platformName: name } = site;
  const lang = m.lang ?? site.defaultLang ?? 'en';
  const t = mailMessages[lang];
  const url = m.payload.url ?? '';
  const signIn = `${issuer}/login`;
  const body: { subject: string; lines: string[] } = {
    verify_email: { subject: t.verify_subject, lines: [t.verify_intro(name), url, t.verify_outro] },
    reset_password: { subject: t.reset_subject, lines: [t.reset_intro(name), url, t.reset_outro] },
    existing_account: {
      subject: t.existing_subject,
      lines: [t.existing_intro(name), t.existing_signin(signIn), t.existing_reset(`${issuer}/forgot-password`), t.existing_outro],
    },
    magic_link: { subject: t.magic_subject, lines: [t.magic_intro(name), url, t.magic_outro] },
    magic_link_unavailable: { subject: t.magic2fa_subject, lines: [t.magic2fa_intro(name), t.magic2fa_signin(signIn)] },
    invitation: { subject: t.invite_subject(name), lines: [t.invite_intro(name), url, t.invite_outro(m.payload.days ?? '7')] },
    passkey_added: { subject: t.passkey_subject, lines: [t.passkey_intro(name), t.passkey_outro(`${issuer}/account`)] },
  }[m.template];
  const color = site.brand?.primaryColor ?? null;
  const linkStyle = color ? ` style="color:${color}"` : '';
  const linkify = (line: string) => escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}"${linkStyle}>${u}</a>`);
  // Branding values are validated (settings.ts) and escaped here as well.
  const logo = site.brand?.logoUrl ? `<p><img src="${escapeHtml(site.brand.logoUrl)}" alt="${escapeHtml(name)}" height="40"></p>` : '';
  return {
    subject: body.subject,
    text: body.lines.join('\n\n'),
    html: `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><body style="font-family:system-ui,sans-serif">${logo}${body.lines.map((l) => `<p>${linkify(l)}</p>`).join('')}</body></html>`,
  };
}

/** `Name <addr@example.com>` or a bare address. */
export function parseSender(from: string): { email: string; name: string } | { email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (m) return m[1] ? { email: m[2]!, name: m[1] } : { email: m[2]! };
  return { email: from.trim() };
}

// --- transports ----------------------------------------------------------------------------------

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

export const SMTP_DEFAULT_PORT = 465;

export interface SmtpOptions extends MailSite {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from: string;
  /**
   * Implicit TLS (default and the only mode a deployment can configure, PRD §21.2): worker-mailer's
   * STARTTLS only upgrades when the server advertises it, which an attacker on the path can strip.
   * `false` exists for the protocol tests against a local plain-text peer.
   */
  tls?: boolean;
  timeoutMs?: number;
}

/** First SMTP reply code in a library error ("550", "535" …), never the reply text (it may echo the recipient). */
const smtpCode = (e: unknown) => /\b([2-5]\d\d)\b/.exec(String((e as Error)?.message ?? ''))?.[1] ?? 'no reply code';

/** SMTP over `cloudflare:sockets` (worker-mailer): one connection per message, AUTH PLAIN / LOGIN when offered. */
export function smtpEmailAdapter(o: SmtpOptions): EmailAdapter {
  return {
    async send(m) {
      const { subject, text, html } = renderEmail(m, o);
      const timeout = o.timeoutMs ?? 15_000;
      let mailer: WorkerMailer;
      try {
        mailer = await WorkerMailer.connect({
          host: o.host,
          port: o.port,
          secure: o.tls !== false,
          startTls: false,
          ...(o.username ? { credentials: { username: o.username, password: o.password ?? '' }, authType: ['plain', 'login'] } : {}),
          logLevel: LogLevel.NONE,
          socketTimeoutMs: timeout,
          responseTimeoutMs: timeout,
          name: new URL(o.issuer).hostname,
        });
      } catch (e) {
        throw new Error(`SMTP session for the ${m.template} email failed (${smtpCode(e)})`);
      }
      try {
        await mailer.send({ from: parseSender(o.from), to: m.to, subject, text, html });
      } catch (e) {
        throw new Error(`SMTP server rejected the ${m.template} email (${smtpCode(e)})`);
      } finally {
        await mailer.close().catch(() => {});
      }
    },
  };
}

/** Cloudflare Email Service through the `send_email` binding (Workers Paid + onboarded sending domain). */
export function cloudflareEmailAdapter(o: MailSite & { binding: SendEmail; from: string }): EmailAdapter {
  return {
    async send(m) {
      const { subject, text, html } = renderEmail(m, o);
      try {
        const sender = parseSender(o.from);
        await o.binding.send({ from: 'name' in sender ? sender : sender.email, to: m.to, subject, text, html });
      } catch (e) {
        const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'unknown error';
        throw new Error(`Cloudflare Email Service rejected the ${m.template} email (${code})`);
      }
    },
  };
}

export type EmailTransport = 'outbox' | 'resend' | 'smtp' | 'cloudflare';

/** The configured transport, or null when mail is unavailable (PRD §21.2). */
export function emailTransport(env: Env): EmailTransport | null {
  if ((env.DEPLOY_ENV as string) === 'local') return 'outbox';
  const e = env as unknown as Record<string, unknown>;
  const from = typeof e.EMAIL_FROM === 'string' && e.EMAIL_FROM.trim() ? e.EMAIL_FROM : null;
  if (!from) return null;
  const chosen = typeof e.EMAIL_TRANSPORT === 'string' ? e.EMAIL_TRANSPORT.trim() : '';
  const kind = chosen || (env.RESEND_API_KEY ? 'resend' : '');
  if (kind === 'resend') return env.RESEND_API_KEY ? 'resend' : null;
  if (kind === 'smtp') return typeof e.SMTP_HOST === 'string' && e.SMTP_HOST.trim() ? 'smtp' : null;
  if (kind === 'cloudflare') return e.SEND_EMAIL && typeof (e.SEND_EMAIL as SendEmail).send === 'function' ? 'cloudflare' : null;
  return null;
}

export const mailAvailable = (env: Env) => emailTransport(env) !== null;
export const magicLinkAvailable = (env: Env) => magicLinkSetting(env) && mailAvailable(env);

export function emailAdapterFor(env: Env): EmailAdapter {
  const e = env as unknown as Record<string, string | undefined>;
  const site = mailSite(env);
  switch (emailTransport(env)) {
    case 'outbox':
      return outboxEmailAdapter(env.DB);
    case 'resend':
      return resendEmailAdapter({ ...site, apiKey: env.RESEND_API_KEY!, from: e.EMAIL_FROM! });
    case 'smtp': {
      const port = Number(e.SMTP_PORT || SMTP_DEFAULT_PORT);
      return smtpEmailAdapter({
        ...site,
        host: e.SMTP_HOST!.trim(),
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : SMTP_DEFAULT_PORT,
        username: e.SMTP_USERNAME?.trim() || undefined,
        password: e.SMTP_PASSWORD,
        from: e.EMAIL_FROM!,
      });
    }
    case 'cloudflare':
      return cloudflareEmailAdapter({ ...site, binding: (env as unknown as { SEND_EMAIL: SendEmail }).SEND_EMAIL, from: e.EMAIL_FROM! });
    default:
      return unconfiguredEmailAdapter;
  }
}
