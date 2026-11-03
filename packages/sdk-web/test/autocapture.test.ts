import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.ts';
import { createSessionTracker } from '../src/autocapture.ts';
import { baseConfig, fakeFetch, json, memoryStore } from './helpers.ts';

const OK = () => json({ accepted: 1, duplicate: 0, rejected: [] });

let win: EventTarget;
let doc: EventTarget & { visibilityState: string; referrer: string; title: string };
let url: URL;
let session: ReturnType<typeof memoryStore>;
let origPush: History['pushState'];
let origReplace: History['replaceState'];
let hist: { pushState: History['pushState']; replaceState: History['replaceState'] };

const nav = (u: string) => void (url = new URL(u, url));

beforeEach(() => {
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible', referrer: 'https://ref.test/', title: 'Home' });
  url = new URL('https://app.test/home');
  session = memoryStore();
  origPush = (_s, _t, u) => void (u != null && nav(String(u)));
  origReplace = (_s, _t, u) => void (u != null && nav(String(u)));
  hist = { pushState: origPush, replaceState: origReplace };
  vi.stubGlobal('localStorage', memoryStore());
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('history', hist);
  vi.stubGlobal('location', {
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get hash() { return url.hash; },
    get href() { return url.href; },
  });
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(autocapture?: { pageViews?: boolean; sessions?: boolean }, analytics = {}) {
  const api = fakeFetch(OK);
  const cb = createClient({
    ...baseConfig({ fetch: api.fetch }),
    analytics: { flushIntervalMs: 0, ...analytics },
    ...(autocapture ? { autocapture } : {}),
  });
  const sent = async () => {
    await cb.analytics.flush();
    return api.calls.flatMap((c) => c.json().events as any[]);
  };
  return { cb, sent };
}

describe('page views', () => {
  it('emits page_view on init with path, referrer and title', async () => {
    const { cb, sent } = setup({ pageViews: true });
    const evs = await sent();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      event_name: 'page_view',
      properties: { path: '/home', referrer: 'https://ref.test/', title: 'Home' },
    });
    cb.dispose();
  });

  it('emits on pushState, replaceState, popstate and hashchange; referrer is the previous page', async () => {
    const { cb, sent } = setup({ pageViews: true });
    hist.pushState(null, '', '/a?x=1');
    hist.replaceState(null, '', '/b');
    nav('/c');
    win.dispatchEvent(new Event('popstate'));
    nav('/c#sec');
    win.dispatchEvent(new Event('hashchange'));
    const evs = await sent();
    expect(evs.map((e) => e.properties.path)).toEqual(['/home', '/a?x=1', '/b', '/c', '/c#sec']);
    expect(evs[1].properties.referrer).toBe('https://app.test/home');
    expect(evs[2].properties.referrer).toBe('https://app.test/a?x=1');
    cb.dispose();
  });

  it('does not repeat a page_view when the path did not change', async () => {
    const { cb, sent } = setup({ pageViews: true });
    hist.pushState(null, '', '/home');
    hist.replaceState(null, '', '/home');
    win.dispatchEvent(new Event('popstate'));
    expect(await sent()).toHaveLength(1);
    cb.dispose();
  });

  it('patches history once per client set and restores it on dispose', async () => {
    const a = setup({ pageViews: true });
    const b = setup({ pageViews: true });
    expect(hist.pushState).not.toBe(origPush);
    a.cb.dispose();
    expect(hist.pushState).not.toBe(origPush); // b still listening
    hist.pushState(null, '', '/x');
    expect((await b.sent()).map((e) => e.properties.path)).toEqual(['/home', '/x']);
    b.cb.dispose();
    expect(hist.pushState).toBe(origPush);
    expect(hist.replaceState).toBe(origReplace);
  });

  it('stops capturing after dispose', async () => {
    const { cb, sent } = setup({ pageViews: true });
    cb.dispose();
    hist.pushState(null, '', '/late');
    nav('/later');
    win.dispatchEvent(new Event('popstate'));
    expect(await sent()).toHaveLength(1);
  });

  it('a throwing history original or broken location never reaches the host', async () => {
    const { cb } = setup({ pageViews: true });
    vi.stubGlobal('location', {
      get pathname(): string { throw new Error('boom'); },
    });
    expect(() => hist.pushState(null, '', '/x')).not.toThrow();
    cb.dispose();
  });

  it('keeps working with the default analytics queue: shares event_id/session fields', async () => {
    const { cb, sent } = setup({ pageViews: true });
    const [ev] = await sent();
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.session_id).toBeTruthy();
    cb.dispose();
  });

  it('honours the sample rate', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { cb, sent } = setup({ pageViews: true }, { sampleRate: 0.5 });
    expect(await sent()).toHaveLength(0);
    cb.dispose();
  });
});

describe('disabled by default', () => {
  it.each([undefined, {}, { pageViews: false, sessions: false }])('captures nothing and leaves history alone (%j)', async (ac) => {
    const { cb, sent } = setup(ac);
    hist.pushState(null, '', '/x');
    win.dispatchEvent(new Event('popstate'));
    expect(hist.pushState).toBe(origPush);
    expect(await sent()).toHaveLength(0);
    cb.dispose();
  });

  it('plain track works without session_start when sessions is off', async () => {
    const { cb, sent } = setup();
    cb.analytics.track('feature_used');
    expect((await sent()).map((e) => e.event_name)).toEqual(['feature_used']);
    cb.dispose();
  });
});

describe('sessions', () => {
  it('emits session_start with the new session id before the first event, once', async () => {
    const { cb, sent } = setup({ sessions: true });
    cb.analytics.track('a');
    cb.analytics.track('b');
    const evs = await sent();
    expect(evs.map((e) => e.event_name)).toEqual(['session_start', 'a', 'b']);
    expect(new Set(evs.map((e) => e.session_id)).size).toBe(1);
    cb.dispose();
  });

  it('rotates the session after 30 minutes of inactivity, measured from the last tracked event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { cb, sent } = setup({ sessions: true });
    cb.analytics.track('a');
    vi.advanceTimersByTime(29 * 60_000);
    cb.analytics.track('b'); // activity keeps it alive
    vi.advanceTimersByTime(29 * 60_000);
    cb.analytics.track('c');
    vi.advanceTimersByTime(31 * 60_000);
    cb.analytics.track('d');
    const evs = await sent();
    expect(evs.map((e) => e.event_name)).toEqual(['session_start', 'a', 'b', 'c', 'session_start', 'd']);
    expect(evs[0].session_id).toBe(evs[3].session_id);
    expect(evs[4].session_id).not.toBe(evs[0].session_id);
    expect(evs[5].session_id).toBe(evs[4].session_id);
    cb.dispose();
  });

  it('a reload (new client, same sessionStorage) keeps the session and does not emit session_start', async () => {
    const first = setup({ sessions: true });
    first.cb.analytics.track('a');
    const [start] = await first.sent();
    first.cb.dispose();

    const second = setup({ sessions: true });
    second.cb.analytics.track('b');
    const evs = await second.sent();
    expect(evs.map((e) => e.event_name)).toEqual(['b']);
    expect(evs[0].session_id).toBe(start.session_id);
    second.cb.dispose();
  });

  it('a reload after the idle window starts a new session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = setup({ sessions: true });
    first.cb.analytics.track('a');
    first.cb.dispose();
    vi.advanceTimersByTime(31 * 60_000);
    const second = setup({ sessions: true });
    second.cb.analytics.track('b');
    expect((await second.sent()).map((e) => e.event_name)).toEqual(['session_start', 'b']);
    second.cb.dispose();
  });

  it('is stored per product and env, so another product never joins the session', () => {
    const store = memoryStore();
    const a = createSessionTracker({ productId: 'prod_a', env: 'dev' }, store).touch(1);
    const b = createSessionTracker({ productId: 'prod_b', env: 'dev' }, store).touch(1);
    expect(b.isNew).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect([...store.map.keys()].sort()).toEqual([
      'zcb.prod_a.dev.session',
      'zcb.prod_b.dev.session',
    ]);
  });

  it('survives unavailable or corrupt sessionStorage', () => {
    const t = createSessionTracker({ productId: 'prod_a', env: 'dev' }, {
      getItem: () => '{not json',
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    const first = t.touch(1);
    expect(first.isNew).toBe(true);
    expect(t.touch(2)).toEqual({ id: first.id, isNew: false });
    expect(() => t.reset()).not.toThrow();
  });

  it('analytics.reset() starts a new session', async () => {
    const { cb, sent } = setup({ sessions: true });
    cb.analytics.track('a');
    cb.analytics.reset();
    cb.analytics.track('b');
    const evs = await sent();
    expect(evs.map((e) => e.event_name)).toEqual(['session_start', 'a', 'session_start', 'b']);
    expect(evs[0].session_id).not.toBe(evs[2].session_id);
    cb.dispose();
  });

  it('page views and sessions combine: session_start precedes the first page_view', async () => {
    const { cb, sent } = setup({ pageViews: true, sessions: true });
    expect((await sent()).map((e) => e.event_name)).toEqual(['session_start', 'page_view']);
    cb.dispose();
  });
});
