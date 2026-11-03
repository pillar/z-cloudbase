import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth.ts';
import { PlatformError } from '../src/errors.ts';
import { CLIENT_ID, ENDPOINT, REDIRECT, apiError, baseConfig, createFakeIdp, fakeFetch, json, memoryStore } from './helpers.ts';

let assign: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.fn>;
let session: ReturnType<typeof memoryStore>;

beforeEach(() => {
  assign = vi.fn();
  replaceState = vi.fn();
  session = memoryStore();
  vi.stubGlobal('location', { href: REDIRECT, assign });
  vi.stubGlobal('history', { state: null, replaceState });
  vi.stubGlobal('sessionStorage', session);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(over: Parameters<typeof baseConfig>[0] = {}) {
  const idp = await createFakeIdp();
  const api = fakeFetch(async (r) => {
    if (r.url.startsWith(ENDPOINT)) return json({ user_id: idp.userId });
    return idp.handler(r);
  });
  const auth = createAuth(baseConfig({ fetch: api.fetch, ...over }));
  const tokenCalls = () => api.calls.filter((c) => c.url.endsWith('/oauth2/token'));
  /** Run the redirect out and back, returning the callback URL the IdP would send the browser to. */
  const roundTrip = async () => {
    await auth.signInWithRedirect();
    return idp.authorize(assign.mock.calls.at(-1)![0]);
  };
  return { idp, api, auth, tokenCalls, roundTrip };
}

describe('signInWithRedirect', () => {
  it('sends an authorization-code + PKCE S256 request with state, nonce and the product resource', async () => {
    const { auth } = await setup();
    await auth.signInWithRedirect();
    const url = new URL(assign.mock.calls[0]![0]);
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe('http://identity.test/api/auth/oauth2/authorize');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('product_a.dev');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('scope')).toBe('openid offline_access');
    expect(p.get('resource')).toBe('urn:platform:product_a.dev');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(p.get('nonce')!.length).toBeGreaterThanOrEqual(32);
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('with guest: true goes through the identity guest entry, wrapping the same authorization request', async () => {
    const { auth } = await setup();
    await auth.signInWithRedirect({ guest: true });
    const url = new URL(assign.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('http://identity.test/guest');
    const inner = new URL(url.searchParams.get('authorize')!);
    expect(inner.origin + inner.pathname).toBe('http://identity.test/api/auth/oauth2/authorize');
    expect(inner.searchParams.get('client_id')).toBe('product_a.dev');
    expect(inner.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('uses fresh state, nonce and verifier on every attempt', async () => {
    const { auth } = await setup();
    await auth.signInWithRedirect();
    await auth.signInWithRedirect();
    const [a, b] = assign.mock.calls.map((c) => new URL(c[0]).searchParams);
    expect(a!.get('state')).not.toBe(b!.get('state'));
    expect(a!.get('nonce')).not.toBe(b!.get('nonce'));
    expect(a!.get('code_challenge')).not.toBe(b!.get('code_challenge'));
  });
});

describe('handleRedirectCallback', () => {
  it('exchanges the code with the PKCE verifier, signs in, notifies and cleans the URL', async () => {
    const { auth, roundTrip, tokenCalls, idp } = await setup();
    const states: unknown[] = [];
    auth.onAuthStateChange((u) => states.push(u));
    const cb = await roundTrip();

    const user = await auth.handleRedirectCallback(cb);

    expect(user).toEqual({ id: idp.userId });
    const form = tokenCalls()[0]!.form();
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('client_secret')).toBeNull();
    expect(states).toEqual([{ id: idp.userId }]);
    expect(await auth.getAccessToken()).toMatch(/^eyJ/);
    // code/state must not linger in the address bar or history
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0]![2]).toBe('/callback');
    expect(session.map.size).toBe(0);
  });

  it('keeps unrelated query parameters when cleaning the URL', async () => {
    const { auth, roundTrip } = await setup();
    const cb = new URL(await roundTrip());
    cb.searchParams.set('tab', 'files');
    await auth.handleRedirectCallback(cb.toString());
    expect(replaceState.mock.calls[0]![2]).toBe('/callback?tab=files');
  });

  it('rejects a state that does not match and never calls the token endpoint', async () => {
    const { auth, roundTrip, tokenCalls } = await setup();
    const cb = new URL(await roundTrip());
    cb.searchParams.set('state', 'attacker-state');
    await expect(auth.handleRedirectCallback(cb.toString())).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(tokenCalls()).toHaveLength(0);
    expect(await auth.getAccessToken()).toBeNull();
  });

  it('rejects when no sign-in is in progress (e.g. a forged callback link)', async () => {
    const { auth, tokenCalls } = await setup();
    await expect(auth.handleRedirectCallback(`${REDIRECT}?code=x&state=y`)).rejects.toBeInstanceOf(PlatformError);
    expect(tokenCalls()).toHaveLength(0);
  });

  it('is single use: replaying the same callback URL fails', async () => {
    const { auth, roundTrip } = await setup();
    const cb = await roundTrip();
    await auth.handleRedirectCallback(cb);
    await expect(auth.handleRedirectCallback(cb)).rejects.toThrow('No sign-in in progress');
  });

  it('rejects an id_token whose nonce differs', async () => {
    const { auth, roundTrip, idp } = await setup();
    idp.nonceOverride = 'some-other-nonce';
    const cb = await roundTrip();
    await expect(auth.handleRedirectCallback(cb)).rejects.toMatchObject({ code: 'nonce_mismatch' });
    expect(await auth.getAccessToken()).toBeNull();
  });

  it('rejects an id_token not signed by the issuer JWKS', async () => {
    const { auth, roundTrip, idp } = await setup();
    idp.forgeIdToken = true;
    const cb = await roundTrip();
    await expect(auth.handleRedirectCallback(cb)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('surfaces an authorization error from the IdP', async () => {
    const { auth, roundTrip } = await setup();
    const cb = new URL(await roundTrip());
    cb.searchParams.delete('code');
    cb.searchParams.set('error', 'access_denied');
    await expect(auth.handleRedirectCallback(cb.toString())).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('rejects a callback whose iss is not the configured issuer', async () => {
    const { auth, roundTrip } = await setup();
    const cb = new URL(await roundTrip());
    cb.searchParams.set('iss', 'http://evil.test');
    await expect(auth.handleRedirectCallback(cb.toString())).rejects.toBeInstanceOf(PlatformError);
  });
});

describe('token lifecycle', () => {
  async function signedIn(over: Parameters<typeof baseConfig>[0] = {}) {
    const s = await setup(over);
    await s.auth.handleRedirectCallback(await s.roundTrip());
    s.api.calls.length = 0;
    return s;
  }

  it('returns the cached token while valid and refreshes shortly before expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth, tokenCalls } = await signedIn();
    const first = await auth.getAccessToken();
    expect(await auth.getAccessToken()).toBe(first);
    expect(tokenCalls()).toHaveLength(0);

    vi.setSystemTime(Date.now() + 880_000); // 20s left, inside the 30s refresh margin
    const second = await auth.getAccessToken();
    expect(second).not.toBe(first);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.form().get('grant_type')).toBe('refresh_token');
  });

  it('rotates: each refresh sends the latest refresh token, never an older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth, tokenCalls, idp } = await signedIn();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 900_000);
      await auth.getAccessToken();
    }
    const sent = tokenCalls().map((c) => c.form().get('refresh_token'));
    // idp.issued[0] came with the code exchange; every refresh must present the previous issue
    expect(sent).toEqual(idp.issued.slice(0, 3));
    expect(new Set(sent).size).toBe(3);
  });

  it('single-flights concurrent refreshes into one token request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth, tokenCalls } = await signedIn();
    vi.setSystemTime(Date.now() + 900_000);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken()));
    expect(tokenCalls()).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('signs out locally when the refresh token is rejected (reuse / revoked)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const storage = memoryStore();
    const { auth, idp } = await signedIn({ storage });
    expect(storage.map.size).toBe(1);
    const states: unknown[] = [];
    auth.onAuthStateChange((u) => states.push(u));
    idp.failToken = json({ error: 'invalid_grant' }, 400);

    vi.setSystemTime(Date.now() + 900_000);
    expect(await auth.getAccessToken()).toBeNull();
    expect(states).toEqual([null]);
    expect(storage.map.size).toBe(0);
  });

  it('keeps the session and does not retry the refresh when the identity service is unavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth, idp, tokenCalls } = await signedIn();
    idp.failToken = json({ error: 'temporarily_unavailable' }, 503);
    vi.setSystemTime(Date.now() + 900_000);
    await expect(auth.getAccessToken()).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(tokenCalls()).toHaveLength(1); // a replayed refresh token could look like theft

    idp.failToken = null;
    expect(await auth.getAccessToken()).toMatch(/^eyJ/); // session survived
  });

  it('persists only the refresh token when a storage adapter is given, and restores from it', async () => {
    const storage = memoryStore();
    const s = await signedIn({ storage });
    const stored = [...storage.map.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(s.idp.issued[0]);
    expect(JSON.stringify([...storage.map.entries()])).not.toContain('eyJ');
    expect(JSON.stringify([...session.map.entries()])).not.toContain(stored[0]!);

    // a new page load: memory is empty, the refresh token brings the session back
    const reload = createAuth(baseConfig({ fetch: s.api.fetch, storage }));
    const states: unknown[] = [];
    reload.onAuthStateChange((u) => states.push(u));
    expect(await reload.getAccessToken()).toMatch(/^eyJ/);
    expect(states).toEqual([{ id: s.idp.userId }]);
    expect(storage.map.get([...storage.map.keys()][0]!)).not.toBe(stored[0]); // rotated
  });

  it('keeps the refresh token in memory only by default', async () => {
    const { auth, idp } = await signedIn();
    expect(JSON.stringify([...session.map.entries()])).not.toContain(idp.issued[0]!);
    expect(await auth.getAccessToken()).toMatch(/^eyJ/);
  });

  it('is signed out when nothing is stored', async () => {
    const { auth, tokenCalls } = await setup();
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.getUser()).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });
});

describe('getUser / signOut', () => {
  it('calls GET /v1/me with the publishable key and bearer token', async () => {
    const s = await setup();
    await s.auth.handleRedirectCallback(await s.roundTrip());
    s.api.calls.length = 0;
    expect(await s.auth.getUser()).toEqual({ user_id: s.idp.userId });
    const call = s.api.calls[0]!;
    expect(call.url).toBe(`${ENDPOINT}/v1/me`);
    expect(call.headers.get('x-platform-key')).toMatch(/^pk_dev_/);
    expect(call.headers.get('authorization')).toMatch(/^Bearer eyJ/);
  });

  it('revokes the refresh token, clears state and notifies on signOut', async () => {
    const storage = memoryStore();
    const s = await setup({ storage });
    await s.auth.handleRedirectCallback(await s.roundTrip());
    const states: unknown[] = [];
    s.auth.onAuthStateChange((u) => states.push(u));

    await s.auth.signOut();

    expect(s.idp.revoked).toEqual([s.idp.issued[0]]);
    expect(states).toEqual([null]);
    expect(storage.map.size).toBe(0);
    expect(await s.auth.getAccessToken()).toBeNull();
  });

  it('still signs out locally when revocation fails', async () => {
    const s = await setup();
    await s.auth.handleRedirectCallback(await s.roundTrip());
    const original = s.api.fetch;
    const failing = createAuth(baseConfig({
      fetch: ((i, init) => String(i).endsWith('/revoke') ? Promise.reject(new TypeError('offline')) : original(i, init)) as typeof fetch,
    }));
    await expect(failing.signOut()).resolves.toBeUndefined();
  });

  it('API errors keep the unified shape (code, request id, retryable)', async () => {
    const idp = await createFakeIdp();
    const api = fakeFetch((r) => (r.url.startsWith(ENDPOINT) ? apiError('forbidden_product', 403) : idp.handler(r)));
    const auth = createAuth(baseConfig({ fetch: api.fetch }));
    await auth.signInWithRedirect();
    await auth.handleRedirectCallback(idp.authorize(assign.mock.calls[0]![0]));
    await expect(auth.getUser()).rejects.toMatchObject({ code: 'forbidden_product', requestId: 'req_test', retryable: false, status: 403 });
    expect(api.calls.filter((c) => c.url.startsWith(ENDPOINT))).toHaveLength(1); // 4xx is not retried
  });
});

describe('configuration', () => {
  it('rejects a publishable key that belongs to another env, or a service key', () => {
    expect(() => createAuth(baseConfig({ env: 'prod' }))).toThrow(/different env/);
    expect(() => createAuth(baseConfig({ publishableKey: `sk_dev_${'a'.repeat(43)}` }))).toThrow(/pk_/);
  });

  it('rejects a discovery document for a different issuer', async () => {
    const api = fakeFetch(() => json({ issuer: 'http://evil.test', authorization_endpoint: 'x', token_endpoint: 'y', jwks_uri: 'z' }));
    const auth = createAuth(baseConfig({ fetch: api.fetch }));
    await expect(auth.signInWithRedirect()).rejects.toMatchObject({ code: 'sdk_error' });
    expect(assign).not.toHaveBeenCalled();
  });
});
