import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.ts';
import { buildAuthorizeUrl, discover, exchangeCode, parseCallback, refreshTokens } from '../src/oidc.ts';

const d = { authorization_endpoint: 'https://id.example/api/auth/oauth2/authorize', token_endpoint: 'https://id.example/api/auth/oauth2/token' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('config', () => {
  it('targets the reserved console client and audience, and requires both origins', () => {
    const cfg = readConfig({ VITE_ISSUER: 'https://id.example/', VITE_API_ORIGIN: 'https://api.example' }, 'https://console.example');
    expect(cfg).toEqual({
      issuer: 'https://id.example', apiOrigin: 'https://api.example', clientId: CONSOLE_CLIENT_ID,
      resource: CONSOLE_AUDIENCE, redirectUri: 'https://console.example/',
    });
    expect(() => readConfig({ VITE_ISSUER: 'https://id.example' }, 'https://x')).toThrow(/VITE_API_ORIGIN/);
  });
});

describe('discovery', () => {
  it('reads {issuer}/.well-known/openid-configuration', async () => {
    const fetchFn = vi.fn(async () => json(d));
    expect(await discover('https://id.example/', fetchFn)).toEqual(d);
    expect(fetchFn).toHaveBeenCalledWith('https://id.example/.well-known/openid-configuration');
  });

  it('fails on HTTP errors and incomplete documents', async () => {
    await expect(discover('https://id.example', async () => new Response('no', { status: 404 }))).rejects.toThrow(/404/);
    await expect(discover('https://id.example', async () => json({ token_endpoint: 'x' }))).rejects.toThrow(/incomplete/);
  });
});

describe('authorize URL', () => {
  it('carries PKCE S256, state and the console resource', () => {
    const url = new URL(buildAuthorizeUrl(d, { clientId: 'platform_console', redirectUri: 'https://console.example/', challenge: 'CH', state: 'ST', resource: CONSOLE_AUDIENCE, scope: 'openid offline_access' }));
    expect(url.origin + url.pathname).toBe(d.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'platform_console', redirect_uri: 'https://console.example/', scope: 'openid offline_access',
      state: 'ST', code_challenge: 'CH', code_challenge_method: 'S256', resource: CONSOLE_AUDIENCE,
    });
  });
});

describe('callback parsing', () => {
  const cb = (qs: string) => new URL(`https://console.example/?${qs}`);

  it('returns the code when state matches', () => {
    expect(parseCallback(cb('code=abc&state=s1'), 's1')).toEqual({ code: 'abc' });
  });

  it('rejects a wrong or missing state (CSRF), a missing code, and provider errors', () => {
    expect(() => parseCallback(cb('code=abc&state=evil'), 's1')).toThrow(/state/);
    expect(() => parseCallback(cb('code=abc&state=s1'), null)).toThrow(/state/);
    expect(() => parseCallback(cb('state=s1'), 's1')).toThrow(/missing/);
    expect(() => parseCallback(cb('error=access_denied&error_description=nope'), 's1')).toThrow(/nope/);
  });
});

describe('token endpoint', () => {
  it('exchanges the code with the verifier and resource, returning expiry from expires_in', async () => {
    const fetchFn = vi.fn(async (_u: unknown, _i?: RequestInit) => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 900 }));
    const t = await exchangeCode(d, { clientId: 'platform_console', redirectUri: 'https://console.example/', code: 'abc', verifier: 'VER', resource: CONSOLE_AUDIENCE }, fetchFn, 1_000);
    expect(t).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1_000 + 900_000 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(d.token_endpoint);
    expect(init!.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toEqual({
      grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://console.example/', client_id: 'platform_console', code_verifier: 'VER', resource: CONSOLE_AUDIENCE,
    });
  });

  it('refreshes with the refresh token', async () => {
    const fetchFn = vi.fn(async (_u: unknown, _i?: RequestInit) => json({ access_token: 'AT2', expires_in: 60 }));
    const t = await refreshTokens(d, { clientId: 'platform_console', refreshToken: 'RT', resource: CONSOLE_AUDIENCE }, fetchFn, 0);
    expect(t).toEqual({ accessToken: 'AT2', expiresAt: 60_000 });
    expect(Object.fromEntries(new URLSearchParams(fetchFn.mock.calls[0]![1]!.body as string))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT' });
  });

  it('surfaces OAuth errors', async () => {
    const fetchFn = async () => json({ error: 'invalid_grant', error_description: 'code already used' }, 400);
    await expect(exchangeCode(d, { clientId: 'c', redirectUri: 'r', code: 'x', verifier: 'v', resource: 'res' }, fetchFn)).rejects.toThrow(/code already used/);
  });
});
