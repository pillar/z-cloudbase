// v3.1 collection (PRD §21.7): js_error, web_vital, element_click autocapture, consent, user properties.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics } from '../src/analytics.ts';
import { createClient } from '../src/index.ts';
import { apiError, baseConfig, fakeFetch, json, memoryStore } from './helpers.ts';

let win: EventTarget;
let doc: EventTarget & { visibilityState: string; referrer: string; title: string };
let local: ReturnType<typeof memoryStore>;

beforeEach(() => {
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: '', title: 'T' });
  local = memoryStore();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', memoryStore());
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { pathname: '/shop', search: '?q=private', hash: '', href: 'https://app.test/shop?q=private' });
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
});
afterEach(() => vi.unstubAllGlobals());

function setup(autocapture: Record<string, unknown> = {}, analytics: Record<string, unknown> = {}, handler?: Parameters<typeof fakeFetch>[0]) {
  const api = fakeFetch(handler ?? (() => json({ accepted: 1, duplicate: 0, rejected: [] })));
  const cb = createClient({ ...baseConfig({ fetch: api.fetch }), analytics: { flushIntervalMs: 0, ...analytics }, autocapture });
  const sent = async () => {
    await cb.analytics.flush();
    return api.calls.filter((c) => c.url.endsWith('/events/batch')).flatMap((c) => c.json().events as any[]);
  };
  return { cb, api, sent };
}

const errorEvent = (o: Record<string, unknown>) => Object.assign(new Event('error'), o);

describe('js_error autocapture', () => {
  it('reports scrubbed, query-free errors and rejections, deduped and capped per page', async () => {
    const { cb, sent } = setup({ errors: true });
    const err = new Error('failed https://api.test/x?token=abc Bearer eyJa.eyJb.sig');
    win.dispatchEvent(errorEvent({ message: err.message, filename: 'https://cdn.test/app.js?v=1', lineno: 10, colno: 5, error: err }));
    win.dispatchEvent(errorEvent({ message: err.message, filename: 'https://cdn.test/app.js?v=1', lineno: 10, colno: 5, error: err })); // duplicate
    win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') }));
    for (let i = 0; i < 20; i++) win.dispatchEvent(errorEvent({ message: `e${i}`, filename: '', lineno: i }));
    const evs = await sent();
    expect(evs.every((e) => e.event_name === 'js_error')).toBe(true);
    expect(evs).toHaveLength(10);
    expect(evs[0].properties).toMatchObject({ type: 'error', message: 'failed https://api.test/x Bearer [REDACTED]', source: 'https://cdn.test/app.js', line: 10, col: 5, path: '/shop' });
    expect(evs[1].properties).toMatchObject({ type: 'unhandledrejection', message: 'nope' });
    expect(JSON.stringify(evs)).not.toMatch(/token=abc|q=private|v=1/);
    cb.dispose();
  });

  it('is off by default', async () => {
    const { sent } = setup();
    win.dispatchEvent(errorEvent({ message: 'x' }));
    expect(await sent()).toEqual([]);
  });
});

describe('web_vital autocapture', () => {
  it('reports each metric once with a rating when the page is hidden', async () => {
    const observers: Array<{ type: string; cb: (l: { getEntries: () => unknown[] }) => void }> = [];
    class FakePO {
      constructor(private cb: (l: { getEntries: () => unknown[] }) => void) {}
      observe(o: { type: string }) { observers.push({ type: o.type, cb: this.cb }); }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakePO);
    vi.stubGlobal('performance', { getEntriesByType: () => [{ responseStart: 950 }] });
    const { cb, sent } = setup({ webVitals: true });
    const emit = (type: string, entries: unknown[]) => observers.filter((o) => o.type === type).forEach((o) => o.cb({ getEntries: () => entries }));
    emit('paint', [{ name: 'first-contentful-paint', startTime: 1200 }]);
    emit('largest-contentful-paint', [{ startTime: 2000 }, { startTime: 4500 }]);
    emit('layout-shift', [{ startTime: 100, value: 0.05, hadRecentInput: false }, { startTime: 300, value: 0.08, hadRecentInput: false }, { startTime: 400, value: 1, hadRecentInput: true }]);
    emit('event', [{ interactionId: 1, duration: 120 }, { interactionId: 2, duration: 260 }, { interactionId: 0, duration: 900 }]);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide')); // second hide: nothing new
    const evs = await sent();
    const byName = Object.fromEntries(evs.map((e) => [e.properties.name, e.properties]));
    expect(evs.every((e) => e.event_name === 'web_vital')).toBe(true);
    expect(evs).toHaveLength(5);
    expect(byName).toMatchObject({
      FCP: { value: 1200, rating: 'good' }, LCP: { value: 4500, rating: 'poor' }, CLS: { value: 0.13, rating: 'needs-improvement' },
      INP: { value: 260, rating: 'needs-improvement' }, TTFB: { value: 950, rating: 'needs-improvement', path: '/shop' },
    });
    cb.dispose();
  });

  it('does nothing without PerformanceObserver', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const { sent } = setup({ webVitals: true });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(await sent()).toEqual([]);
  });
});

describe('element_click autocapture', () => {
  /** Minimal element double: `closest` walks `parent`, selector support limited to what startClicks asks. */
  function el(tag: string, o: { id?: string; className?: string; text?: string; attrs?: Record<string, string>; parent?: any; href?: string; hasField?: boolean } = {}): any {
    const matches = (sel: string, e: any): boolean => sel.split(',').some((s) => {
      s = s.trim();
      if (s === '[data-zcb-track]') return 'data-zcb-track' in (e.attrs ?? {});
      if (s === '[data-zcb-no-track]') return 'data-zcb-no-track' in (e.attrs ?? {});
      if (s === '[role=button]') return e.attrs?.role === 'button';
      const m = /^input\[type=(\w+)\]$/.exec(s);
      if (m) return e.tagName === 'INPUT' && e.attrs?.type === m[1];
      return e.tagName.toLowerCase() === s;
    });
    const e: any = {
      tagName: tag.toUpperCase(), id: o.id ?? '', className: o.className ?? '', textContent: o.text ?? '', attrs: o.attrs ?? {}, parent: o.parent ?? null, href: o.href,
      getAttribute: (n: string) => e.attrs[n] ?? null,
      querySelector: () => (o.hasField ? {} : null),
      closest(sel: string) {
        for (let cur = e; cur; cur = cur.parent) if (matches(sel, cur)) return cur;
        return null;
      },
    };
    return e;
  }
  const click = (target: unknown) => doc.dispatchEvent(Object.assign(new Event('click'), { __t: target }));
  beforeEach(() => {
    // Event.target is read-only; route through a getter.
    const orig = Object.getOwnPropertyDescriptor(Event.prototype, 'target')!;
    vi.spyOn(Event.prototype, 'target', 'get').mockImplementation(function (this: any) { return this.__t ?? orig.get!.call(this); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('captures buttons and links with selector, text and a query-free href; never input values', async () => {
    const { cb, sent } = setup({ clicks: true });
    const button = el('button', { id: 'buy', className: 'btn primary', text: '  Buy   now ' });
    click(el('span', { parent: button })); // click on a child
    click(el('a', { text: 'Docs', href: 'https://app.test/docs?ref=x' }));
    click(el('input', { attrs: { type: 'submit', value: 'secret-value' } }));
    click(el('input', { attrs: { type: 'text' } })); // not interactive for us
    click(el('div', { text: 'plain' }));
    click(el('div', { text: 'Card with field', attrs: { 'data-zcb-track': 'signup_card' }, hasField: true }));
    click(el('button', { text: 'hidden', parent: el('div', { attrs: { 'data-zcb-no-track': '' } }) }));
    const evs = await sent();
    expect(evs.map((e) => e.properties)).toEqual([
      { tag: 'button', selector: 'button#buy.btn.primary', text: 'Buy now', path: '/shop' },
      { tag: 'a', selector: 'a', text: 'Docs', href: 'https://app.test/docs', path: '/shop' },
      { tag: 'input', selector: 'input', path: '/shop' },
      { tag: 'div', selector: 'div', label: 'signup_card', path: '/shop' },
    ]);
    expect(JSON.stringify(evs)).not.toContain('secret-value');
    cb.dispose();
  });

  it("'attribute' mode captures only marked elements", async () => {
    const { sent } = setup({ clicks: 'attribute' });
    click(el('button', { text: 'x' }));
    click(el('div', { text: 'Promo', attrs: { 'data-zcb-track': 'promo' } }));
    expect((await sent()).map((e) => e.properties.label)).toEqual(['promo']);
  });
});

describe('consent', () => {
  it('optOut drops queued events and the anonymous id, persists, and optIn resumes', async () => {
    const { cb, sent, api } = setup();
    cb.analytics.track('a');
    cb.analytics.optOut();
    cb.analytics.track('b');
    expect(cb.analytics.hasOptedOut()).toBe(true);
    expect(await sent()).toEqual([]);
    expect([...local.map.keys()].some((k) => k.endsWith('anonymous_id'))).toBe(false);
    await expect(cb.analytics.setUserProperties({ plan: 'pro' })).rejects.toMatchObject({ code: 'sdk_error' });
    expect(api.calls).toHaveLength(0);

    // A new page load remembers the choice even when the app's default is "granted".
    const again = setup();
    again.cb.analytics.track('c');
    expect(again.cb.analytics.hasOptedOut()).toBe(true);
    expect(await again.sent()).toEqual([]);
    again.cb.analytics.optIn();
    again.cb.analytics.track('d');
    expect((await again.sent()).map((e) => e.event_name)).toEqual(['d']);
  });

  it("consent: 'denied' starts opted out until the visitor opts in", async () => {
    const { cb, sent } = setup({ errors: true }, { consent: 'denied' });
    cb.analytics.track('x');
    win.dispatchEvent(errorEvent({ message: 'boom' }));
    expect(await sent()).toEqual([]);
    cb.analytics.optIn();
    cb.analytics.track('y');
    expect((await sent()).map((e) => e.event_name)).toEqual(['y']);
  });
});

describe('user properties', () => {
  const withAuth = (token: string | null, handler: Parameters<typeof fakeFetch>[0]) => {
    const api = fakeFetch(handler);
    const auth = { getAccessToken: vi.fn(async () => token), peekAccessToken: vi.fn(() => token) };
    return { api, analytics: createAnalytics(baseConfig({ fetch: api.fetch }), auth, { flushIntervalMs: 0 }) };
  };

  it('setUserProperties needs a signed-in user and posts only the properties with its token', async () => {
    const anon = withAuth(null, () => json({}));
    await expect(anon.analytics.setUserProperties({ plan: 'pro' })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(anon.api.calls).toHaveLength(0);
    const { api, analytics } = withAuth('tok', () => json({ properties: { plan: 'pro' } }));
    expect(await analytics.setUserProperties({ plan: 'pro', old: null })).toEqual({ plan: 'pro' });
    expect(api.calls[0]!.url).toBe('http://api.test/v1/events/user-properties');
    expect(api.calls[0]!.json()).toEqual({ properties: { plan: 'pro', old: null } });
    expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer tok');
  });

  it('identify(properties) sets them without throwing on failure', async () => {
    const { api, analytics } = withAuth('tok', () => apiError('payload_too_large', 413));
    analytics.identify({ plan: 'pro' });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.calls.map((c) => c.url)).toEqual(['http://api.test/v1/events/user-properties']);
  });
});
