import { PUBLISHABLE_KEY_RE, SERVICE_KEY_RE, keyEnvironment, type Environment } from '@z-cloudbase/contracts';

export type KeyKind = 'publishable' | 'service';

export function classifyKey(key: string): { kind: KeyKind; env: Environment } | null {
  const env = keyEnvironment(key);
  if (!env) return null;
  if (PUBLISHABLE_KEY_RE.test(key)) return { kind: 'publishable', env };
  if (SERVICE_KEY_RE.test(key)) return { kind: 'service', env };
  return null;
}

/** Service keys are stored only as SHA-256 hex (PRD §19.3). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of equal-length strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pseudonymous per-product analytics key: HMAC-SHA256(user_id, salt), base64url (PRD §19.8). */
export async function userKey(userId: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
