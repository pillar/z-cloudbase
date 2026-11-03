// RFC 6238 TOTP (HMAC-SHA-1, 30 s, 6 digits — the authenticator-app defaults) for tests that
// complete the identity worker's admin MFA. Independent of the auth engine's own implementation;
// WebCrypto only, so it runs in Node and in workerd. No dependencies: tests/e2e imports this file
// by path.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (the `secret` of an otpauth:// URI); padding and case are ignored. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error(`invalid base32 character ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The TOTP code for a base32 secret at `timeMs` (default: now). */
export async function totp(secretBase32: string, timeMs = Date.now(), opts: { period?: number; digits?: number } = {}): Promise<string> {
  const period = opts.period ?? 30;
  const digits = opts.digits ?? 6;
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(timeMs / 1000 / period)));
  const key = await crypto.subtle.importKey('raw', base32Decode(secretBase32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}
