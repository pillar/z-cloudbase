// Client of the identity worker's operator setup endpoints (services/identity/src/setup.ts), shared
// by `pnpm platform:deploy`, `pnpm platform:reset-admin` and the local bootstrap / e2e stack.
import { randomBytes, randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Random administrator password: 24 characters from an unambiguous alphabet (~140 bits). */
export function generatePassword(length = 24): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Random SETUP_TOKEN / AUTH_SECRET value (256 bits, hex). */
export const randomSecret = () => randomBytes(32).toString('hex');

async function post<T>(issuer: string, path: string, token: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${issuer.replace(/\/+$/, '')}/setup${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A new custom domain or workers.dev route may need a minute for DNS / certificates.
      if (attempt < 20) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as T;
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON
    }
    // A freshly put SETUP_TOKEN (or a new deployment) takes a moment to reach every location: until
    // then the old token is checked (401) or the routes do not exist yet (404 "Not found").
    const notYet = res.status === 401 || (res.status === 404 && message === 'Not found');
    if (notYet && attempt < 10) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    throw new Error(`${path} failed: HTTP ${res.status} ${message}`);
  }
}

export type InstallResult =
  | { admin: 'created'; user_id: string; console_client: { clientId: string; resource: string } }
  | { admin: 'exists'; console_client: { clientId: string; resource: string } };

/** Register the console client and, on a platform without an owner, create the first administrator. */
export function installPlatform(issuer: string, token: string, o: { adminEmail: string; adminPassword: string; consoleRedirectUris: string[] }) {
  return post<InstallResult>(issuer, '/install', token, {
    admin_email: o.adminEmail,
    admin_password: o.adminPassword,
    console_redirect_uris: o.consoleRedirectUris,
  });
}

/** New password for an administrator; signs it out everywhere and optionally removes its TOTP. */
export function resetAdmin(issuer: string, token: string, o: { email: string; password: string; disable2fa: boolean }) {
  return post<{ user_id: string; disabled_2fa: boolean }>(issuer, '/reset-admin', token, {
    email: o.email,
    password: o.password,
    disable_2fa: o.disable2fa,
  });
}
