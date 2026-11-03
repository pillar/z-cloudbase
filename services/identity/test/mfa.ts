// Test-side admin MFA: TOTP enrollment through the identity pages and console authorization
// through the login form + second-factor page, with codes computed by @z-cloudbase/testing (RFC 6238).
import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';
import { totp } from '@z-cloudbase/testing';
import { env } from 'cloudflare:workers';
import { CookieJar, PASSWORD, call } from './helpers.ts';
import { authorizeUrl, exchangeCode, pkcePair, randomToken, type TokenResponse } from './oauth-flow.ts';

export const CONSOLE = { id: CONSOLE_CLIENT_ID, redirectUri: 'https://console.example.test/callback' };

const location = (res: Response) => new URL(res.headers.get('location')!, env.ISSUER);

/**
 * Enroll TOTP for the jar's signed-in user via /two-factor/setup (password, then the first code).
 * Returns the secret and the backup codes shown once, and where the confirmation redirected.
 */
export async function enrollTotp(jar: CookieJar, ret = '', password = PASSWORD) {
  const res = await call('/two-factor/setup', { jar, form: { password, return: ret } });
  const page = await res.text();
  if (res.status !== 200) throw new Error(`setup: ${res.status} ${page.slice(0, 300)}`);
  const secret = /data-totp-secret>([A-Z2-7]+)</.exec(page)?.[1];
  if (!secret) throw new Error('setup page shows no TOTP key');
  const backupCodes = [...page.matchAll(/data-backup-code>([^<]+)</g)].map((m) => m[1]!);
  const confirm = await call('/two-factor/setup/confirm', { jar, form: { code: await totp(secret), return: ret } });
  if (confirm.status !== 302) throw new Error(`confirm: ${confirm.status} ${(await confirm.text()).slice(0, 300)}`);
  return { secret, backupCodes, next: location(confirm), page };
}

/** Start a console authorization without a session and submit the login form; returns the next hop. */
export async function startConsoleLogin(jar: CookieJar, email: string, password = PASSWORD) {
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const first = await call(
    authorizeUrl({ productId: '', env: 'prod', state, nonce: randomToken(), challenge, client: CONSOLE, resource: CONSOLE_AUDIENCE }),
    { jar },
  );
  if (first.status !== 302) throw new Error(`authorize: ${first.status}`);
  const login = location(first);
  const res = await call('/login', { jar, form: { email, password, oauth_query: login.search.slice(1) } });
  if (res.status !== 302) throw new Error(`login: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return { verifier, state, next: location(res) };
}

/** Exchange the console callback's code. */
export async function consoleToken(callback: URL, verifier: string) {
  const code = callback.searchParams.get('code');
  if (!code) throw new Error(`no code in ${callback}`);
  return exchangeCode('', 'prod', code, verifier, CONSOLE);
}

/** Full console sign-in of a TOTP-enrolled user: login form, then the code on /two-factor. */
export async function consoleLogin(email: string, secret: string): Promise<TokenResponse> {
  const jar = new CookieJar();
  const { verifier, next } = await startConsoleLogin(jar, email);
  if (next.pathname !== '/two-factor') throw new Error(`expected the second-factor page, got ${next}`);
  const res = await call('/two-factor', {
    jar,
    form: { code: await totp(secret), oauth_query: next.searchParams.get('oauth_query') ?? '', return: '' },
  });
  if (res.status !== 302) throw new Error(`two-factor: ${res.status}`);
  const token = await consoleToken(location(res), verifier);
  if (token.status !== 200) throw new Error(`token: ${token.status} ${await token.text()}`);
  return token.json<TokenResponse>();
}
