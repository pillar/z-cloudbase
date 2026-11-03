// Identity page language and branding (PRD §21.4): ?lang → cookie → Accept-Language → DEFAULT_LANG,
// mail in the language of the request that caused it, validated branding values only.
import { describe, expect, it, afterEach } from 'vitest';
import { fromAcceptLanguage } from '../src/i18n.ts';
import { uiMessages } from '../src/messages.ts';
import { brand, validColor, validLogoUrl } from '../src/settings.ts';
import { CookieJar, PASSWORD, call, outbox, uniqueEmail, useEnv } from './helpers.ts';
import { env } from 'cloudflare:workers';

afterEach(() => useEnv(null));

const title = async (res: Response) => /<h1>([^<]*)<\/h1>/.exec(await res.text())?.[1];

describe('language selection', () => {
  it('parses Accept-Language by q-value', () => {
    expect(fromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(fromAcceptLanguage('fr-FR, en;q=0.5, zh;q=0.7')).toBe('zh');
    expect(fromAcceptLanguage('fr, de')).toBeNull();
    expect(fromAcceptLanguage('zh;q=0, en')).toBe('en');
    expect(fromAcceptLanguage(undefined)).toBeNull();
  });

  it('both languages define the same keys', () => {
    expect(Object.keys(uiMessages.zh).sort()).toEqual(Object.keys(uiMessages.en).sort());
  });

  it('Accept-Language picks the page language, DEFAULT_LANG applies without one', async () => {
    expect(await title(await call('/login', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } }))).toBe('登录');
    expect(await title(await call('/login'))).toBe('Sign in');
    useEnv({ DEFAULT_LANG: 'zh' });
    const page = await (await call('/login')).text();
    expect(page).toContain('<html lang="zh-CN">');
  });

  it('?lang= stores the choice in a cookie and reloads the same address without it; the cookie beats Accept-Language', async () => {
    const jar = new CookieJar();
    const res = await call('/login?client_id=a.prod&sig=abc&lang=zh', { jar });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?client_id=a.prod&sig=abc');
    expect(jar.cookies.get('zcb_lang')).toBe('zh');
    expect(await title(await call('/login', { jar, headers: { 'accept-language': 'en' } }))).toBe('登录');
    // Unknown values are ignored (no cookie change).
    await call('/login?lang=fr', { jar });
    expect(jar.cookies.get('zcb_lang')).toBe('zh');
  });

  it('the switch never redirects off the identity origin', async () => {
    for (const path of ['//evil.example/x?lang=zh', '/\\evil.example/x?lang=en']) {
      const res = await call(path);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!, env.ISSUER).origin).toBe(env.ISSUER);
    }
  });

  it('every page offers the switch to the other language, keeping the signed query', async () => {
    const page = await (await call('/login?client_id=a.prod&sig=abc')).text();
    expect(page).toContain('href="/login?client_id=a.prod&amp;sig=abc&amp;lang=zh"');
  });

  it('mail goes out in the language of the request that caused it', async () => {
    const email = uniqueEmail('zh-mail');
    await call('/api/auth/sign-up/email', { headers: { 'accept-language': 'zh-CN' }, json: { email, password: PASSWORD, name: '' } });
    await call('/api/auth/request-password-reset', { headers: { 'accept-language': 'en' }, json: { email, redirectTo: '/reset-password' } });
    const mails = await outbox(email);
    expect(mails.find((m) => m.template === 'verify_email')?.payload.lang).toBe('zh');
    expect(mails.find((m) => m.template === 'reset_password')?.payload.lang).toBe('en');
  });
});

describe('branding', () => {
  it('validates the deployment values strictly', () => {
    expect(validLogoUrl('https://cdn.example/logo.svg')).toBe(true);
    for (const bad of ['http://cdn.example/logo.svg', 'javascript:alert(1)', 'https://x/"onerror=alert(1)', 'https://x/a b', 'data:image/png;base64,AA', `https://x/${'a'.repeat(2100)}`]) {
      expect(validLogoUrl(bad), bad).toBe(false);
    }
    expect(validColor('#4f46e5')).toBe(true);
    expect(validColor('#abc')).toBe(true);
    for (const bad of ['red', '#12345', '#4f46e5;}body{display:none', 'url(x)']) expect(validColor(bad), bad).toBe(false);
    expect(brand({ ...env, SIGNIN_TAGLINE: 'line\nbreak' } as unknown as Env).tagline).toBeNull();
  });

  it('applies logo, color and tagline to the sign-in page; invalid values fall back to the defaults', async () => {
    useEnv({ BRAND_LOGO_URL: 'https://cdn.example/logo.svg', BRAND_PRIMARY_COLOR: '#FF0066', SIGNIN_TAGLINE: 'Play <b>more</b>' });
    const page = await (await call('/login')).text();
    expect(page).toContain('<img src="https://cdn.example/logo.svg"');
    expect(page).toContain('--brand:#ff0066');
    expect(page).toContain('Play &lt;b&gt;more&lt;/b&gt;');

    useEnv({ BRAND_LOGO_URL: 'javascript:alert(1)', BRAND_PRIMARY_COLOR: 'red;}body{display:none' });
    const fallback = await (await call('/login')).text();
    expect(fallback).not.toContain('javascript:');
    expect(fallback).not.toContain('display:none');
    expect(fallback).toContain('--brand:#4f46e5');
  });
});
