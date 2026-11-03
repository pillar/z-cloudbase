// Browser login session. Tokens live in module memory only (never localStorage); a reload re-runs the
// redirect, which the identity SSO session turns into a silent round trip. Only the PKCE verifier and
// state (and the page to return to: the hash route) are kept in sessionStorage, for the duration of the redirect.
import type { Config } from './config.ts';
import { buildAuthorizeUrl, discover, exchangeCode, parseCallback, refreshTokens, type Discovery, type Tokens } from './oidc.ts';
import { createPkcePair, randomToken } from './pkce.ts';

const PENDING_KEY = 'console.oidc.pending';
const SCOPE = 'openid offline_access';
const REFRESH_MARGIN_MS = 30_000;

let tokens: Tokens | null = null;
let discovery: Discovery | null = null;
let refreshing: Promise<Tokens> | null = null;

const getDiscovery = async (cfg: Config) => (discovery ??= await discover(cfg.issuer));

function takePending(): { verifier: string; state: string; returnHash?: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as { verifier: string; state: string; returnHash?: string }) : null;
  } catch {
    return null;
  }
}

/** Leave for the identity worker's authorization endpoint. */
export async function startLogin(cfg: Config): Promise<void> {
  const d = await getDiscovery(cfg);
  const { verifier, challenge } = await createPkcePair();
  const state = randomToken(16);
  try {
    // The redirect URI has no fragment, so remember the hash route to come back to it (deep links, reloads).
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnHash: location.hash }));
  } catch {
    throw new Error('Browser storage is unavailable; sign-in needs sessionStorage');
  }
  location.assign(buildAuthorizeUrl(d, { clientId: cfg.clientId, redirectUri: cfg.redirectUri, challenge, state, resource: cfg.resource, scope: SCOPE }));
}

let callback: Promise<void> | null = null;

/** Finish a login if the current URL is the redirect back (idempotent, so StrictMode double effects are safe). */
export function completeLoginIfCallback(cfg: Config): Promise<boolean> {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return Promise.resolve(false);
  callback ??= (async () => {
    const pending = takePending();
    try {
      const { code } = parseCallback(url, pending?.state ?? null);
      tokens = await exchangeCode(await getDiscovery(cfg), {
        clientId: cfg.clientId, redirectUri: cfg.redirectUri, code, verifier: pending!.verifier, resource: cfg.resource,
      });
    } finally {
      // Drop code/state from the address bar and return to the page the login started from.
      history.replaceState(null, '', url.pathname + (pending?.returnHash || url.hash));
      dispatchEvent(new HashChangeEvent('hashchange')); // replaceState fires no event; the router listens for this
    }
  })();
  return callback.then(() => true);
}

export const hasSession = () => tokens !== null;

/** A valid access token, refreshing it shortly before expiry. */
export async function getAccessToken(cfg: Config): Promise<string> {
  if (!tokens) throw new Error('Not signed in');
  if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
  if (!tokens.refreshToken) {
    tokens = null;
    throw new Error('Session expired');
  }
  const refreshToken = tokens.refreshToken;
  refreshing ??= getDiscovery(cfg)
    .then((d) => refreshTokens(d, { clientId: cfg.clientId, refreshToken, resource: cfg.resource }))
    .finally(() => (refreshing = null));
  try {
    tokens = await refreshing;
  } catch (e) {
    tokens = null;
    throw e;
  }
  return tokens.accessToken;
}

export function clearSession(): void {
  tokens = null;
}
