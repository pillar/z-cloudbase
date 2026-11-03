// Standard Webhooks signatures (https://www.standardwebhooks.com/, PRD §21.6): `webhook-id`,
// `webhook-timestamp` (Unix seconds) and `webhook-signature` = space-separated `v1,<base64 HMAC-SHA256>`
// over `{id}.{timestamp}.{body}`, keyed with the base64-decoded part of a `whsec_` secret.
// WebCrypto only, so the same code runs in Workers, Node and browsers' server runtimes.
import { WEBHOOK_TOLERANCE_S } from '@z-cloudbase/contracts';
import { timingSafeEqual } from './credentials.ts';

const SECRET_PREFIX = 'whsec_';

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function secretKeyBytes(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  let bin: string;
  try {
    bin = atob(raw);
  } catch {
    throw new Error('Webhook secret is not valid base64');
  }
  if (bin.length < 16) throw new Error('Webhook secret is too short');
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** New signing secret: `whsec_` + base64 of 32 random bytes. */
export function newWebhookSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** `v1,<signature>` for one secret. */
export async function signWebhook(secret: string, msgId: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secretKeyBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${msgId}.${timestamp}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/** The three request headers; several secrets (rotation grace) give several signatures. */
export async function webhookHeaders(secrets: string[], msgId: string, timestamp: number, body: string): Promise<Record<string, string>> {
  const signatures = await Promise.all(secrets.map((s) => signWebhook(s, msgId, timestamp, body)));
  return { 'webhook-id': msgId, 'webhook-timestamp': String(timestamp), 'webhook-signature': signatures.join(' ') };
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Verify a received webhook: one of the `v1` signatures must match (constant-time) and the timestamp
 * must be within `toleranceS` of now (replay window). Returns the message id and timestamp; throws
 * `WebhookVerificationError` otherwise. `body` must be the raw request body, byte for byte.
 */
export async function verifyWebhookSignature(o: {
  secret: string;
  headers: HeaderSource;
  body: string;
  toleranceS?: number;
  now?: number;
}): Promise<{ id: string; timestamp: number }> {
  const id = header(o.headers, 'webhook-id');
  const ts = header(o.headers, 'webhook-timestamp');
  const sigs = header(o.headers, 'webhook-signature');
  if (!id || !ts || !sigs) throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError('Invalid webhook-timestamp');
  const timestamp = Number(ts);
  const nowS = Math.floor((o.now ?? Date.now()) / 1000);
  const tolerance = o.toleranceS ?? WEBHOOK_TOLERANCE_S;
  if (Math.abs(nowS - timestamp) > tolerance) throw new WebhookVerificationError('Webhook timestamp is outside the tolerance window');
  const expected = await signWebhook(o.secret, id, timestamp, o.body);
  const ok = sigs.split(' ').some((s) => s.startsWith('v1,') && timingSafeEqual(s, expected));
  if (!ok) throw new WebhookVerificationError('No matching webhook signature');
  return { id, timestamp };
}
