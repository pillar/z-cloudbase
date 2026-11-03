import { WEB_ERRORS_PER_PAGE } from '@z-cloudbase/contracts';
import type { ClientConfig, KeyValueStore } from './config.ts';
import { originPath, scrub, stripUrlQueries } from './scrub.ts';

export interface AutocaptureOptions {
  /** Emit `page_view` on init and on pushState / replaceState / popstate / hashchange. Default false. */
  pageViews?: boolean;
  /** Rotate `session_id` after 30 minutes without a tracked event and emit `session_start`. Default false. */
  sessions?: boolean;
  /** Emit `js_error` for uncaught errors and unhandled rejections (scrubbed, deduped, ≤ 10 per page). Default false. */
  errors?: boolean;
  /** Emit `web_vital` (LCP, INP, CLS, FCP, TTFB) once per metric when the page is hidden. Default false. */
  webVitals?: boolean;
  /**
   * Emit `element_click` for interactive elements and `[data-zcb-track]` (`'attribute'`: only the latter).
   * Input values are never read; `[data-zcb-no-track]` opts a subtree out. Default false.
   */
  clicks?: boolean | 'attribute';
}

type Track = (name: string, props: Record<string, unknown>) => void;
const noop = () => {};

/** Page path for analytics: pathname, plus a `#/` route hash; never the query string (PRD §21.7). */
export function currentPath(): string {
  try {
    const hash = location.hash.startsWith('#/') ? location.hash.split('?')[0]! : '';
    return location.pathname + hash;
  } catch {
    return '';
  }
}

/** Decides which session an event at time `now` belongs to; used by analytics when sessions are on. */
export interface SessionTracker {
  touch(now: number): { id: string; isNew: boolean };
  reset(): void;
}

export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Session persisted per product and env in `sessionStorage`, so a reload keeps the session while a
 * new tab or a closed browser starts a fresh one. Falls back to memory when storage is unavailable.
 */
export function createSessionTracker(
  config: Pick<ClientConfig, 'productId' | 'env'>,
  storage?: KeyValueStore,
): SessionTracker {
  const key = `zcb.${config.productId}.${config.env}.session`;
  let cur: { id: string; last: number } | null = null;
  const store = (): KeyValueStore | null => {
    try {
      return storage ?? globalThis.sessionStorage ?? null;
    } catch {
      return null;
    }
  };
  function load() {
    try {
      const v = JSON.parse(store()?.getItem(key) ?? 'null');
      if (v && typeof v.id === 'string' && typeof v.last === 'number') cur = v;
    } catch {
      // corrupt or unavailable: start fresh
    }
  }
  return {
    touch(now) {
      if (!cur) load();
      const isNew = !cur || now - cur.last > SESSION_IDLE_MS;
      cur = { id: isNew ? crypto.randomUUID() : cur!.id, last: now };
      try {
        store()?.setItem(key, JSON.stringify(cur));
      } catch {
        // kept in memory
      }
      return { id: cur.id, isNew };
    },
    reset() {
      cur = null;
      try {
        store()?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

type Listener = () => void;
const patched = new WeakMap<History, { listeners: Set<Listener>; undo: () => void }>();

/** Patch pushState/replaceState once per History; the last unsubscribe restores them. */
function watchHistory(h: History, fn: Listener): () => void {
  let p = patched.get(h);
  if (!p) {
    const origPush = h.pushState;
    const origReplace = h.replaceState;
    const listeners = new Set<Listener>();
    const wrap = (orig: History['pushState']): History['pushState'] =>
      function (this: History, ...args) {
        const r = orig.apply(this, args);
        for (const l of [...listeners]) l();
        return r;
      };
    const push = wrap(origPush);
    const replace = wrap(origReplace);
    h.pushState = push;
    h.replaceState = replace;
    p = {
      listeners,
      undo() {
        // If someone wrapped us after, leave their chain intact; our wrappers are inert with no listeners.
        if (h.pushState === push) h.pushState = origPush;
        if (h.replaceState === replace) h.replaceState = origReplace;
        patched.delete(h);
      },
    };
    patched.set(h, p);
  }
  const state = p;
  state.listeners.add(fn);
  return () => {
    state.listeners.delete(fn);
    if (state.listeners.size === 0 && patched.get(h) === state) state.undo();
  };
}

/** Starts page_view capture; returns the teardown. Never throws into the host. */
export function startPageViews(track: (name: string, props: Record<string, unknown>) => void): () => void {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return () => {};
    let lastPath: string | null = null;
    let lastHref = '';
    const capture = () => {
      try {
        const path = currentPath();
        if (path === lastPath) return;
        const referrer = originPath(lastPath === null ? globalThis.document?.referrer : lastHref);
        lastPath = path;
        lastHref = location.href;
        track('page_view', { path, referrer, title: globalThis.document?.title ?? '' });
      } catch {
        // never break the host
      }
    };
    const unwatch = watchHistory(history, capture);
    globalThis.addEventListener?.('popstate', capture);
    globalThis.addEventListener?.('hashchange', capture);
    capture();
    return () => {
      unwatch();
      globalThis.removeEventListener?.('popstate', capture);
      globalThis.removeEventListener?.('hashchange', capture);
    };
  } catch {
    return () => {};
  }
}

const listen = (target: EventTarget | undefined, type: string, fn: (e: any) => void, capture = false) => {
  target?.addEventListener?.(type, fn, capture);
  return () => target?.removeEventListener?.(type, fn, capture);
};

/** `js_error` for uncaught errors and unhandled rejections; returns the teardown. */
export function startErrors(track: Track): () => void {
  const seen = new Set<string>();
  const report = (type: string, message: string, source: string, line: number, col: number, stack?: string) => {
    try {
      const key = `${message}|${source}|${line}`;
      if (seen.size >= WEB_ERRORS_PER_PAGE || seen.has(key)) return;
      seen.add(key);
      const clean = (v: string) => stripUrlQueries(scrub(v));
      track('js_error', {
        type, message: clean(message || 'Error').slice(0, 512), stack: stack ? clean(stack).slice(0, 1000) : '',
        source: originPath(source), line: line || 0, col: col || 0, path: currentPath(),
      });
    } catch {
      // never break the host
    }
  };
  const offError = listen(globalThis, 'error', (e: ErrorEvent) =>
    report('error', e.message || e.error?.message || '', e.filename || '', e.lineno, e.colno, e.error?.stack));
  const offRejection = listen(globalThis, 'unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
    report('unhandledrejection', typeof r?.message === 'string' ? r.message : String(r), '', 0, 0, typeof r?.stack === 'string' ? r.stack : undefined);
  });
  return () => (offError(), offRejection());
}

type Vital = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
/** good / poor thresholds (web.dev). */
const THRESHOLDS: Record<Vital, [number, number]> = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] };

/**
 * `web_vital` per metric, from PerformanceObserver (no dependency). Reported once when the page is first hidden;
 * `flush` then sends the queue with keepalive. INP is the slowest interaction (an approximation of web.dev's p98).
 */
export function startWebVitals(track: Track, flush: () => void = noop): () => void {
  const PO = globalThis.PerformanceObserver;
  if (typeof PO === 'undefined') return noop;
  const v: Partial<Record<Vital, number>> = {};
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, fn: (e: any) => void, extra: Record<string, unknown> = {}) => {
    try {
      const po = new PO((list) => list.getEntries().forEach(fn));
      po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(po);
    } catch {
      // entry type not supported by this browser
    }
  };
  observe('paint', (e) => e.name === 'first-contentful-paint' && (v.FCP = e.startTime));
  observe('largest-contentful-paint', (e) => (v.LCP = e.startTime));
  let session = 0;
  let first = 0;
  let last = 0;
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    if (session && e.startTime - last < 1000 && e.startTime - first < 5000) session += e.value;
    else (session = e.value), (first = e.startTime);
    last = e.startTime;
    v.CLS = Math.max(v.CLS ?? 0, session);
  });
  const interaction = (e: any) => (e.interactionId || e.entryType === 'first-input') && (v.INP = Math.max(v.INP ?? 0, e.duration));
  observe('event', interaction, { durationThreshold: 40 });
  observe('first-input', interaction);
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) v.TTFB = nav.responseStart;
  } catch {
    // no Navigation Timing
  }
  let done = false;
  const report = () => {
    if (done) return;
    done = true;
    for (const name of Object.keys(v) as Vital[]) {
      const value = v[name]!;
      const [good, poor] = THRESHOLDS[name];
      track('web_vital', {
        name, value: name === 'CLS' ? Math.round(value * 10000) / 10000 : Math.round(value),
        rating: value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor', path: currentPath(),
      });
    }
    flush();
  };
  const onHidden = () => globalThis.document?.visibilityState === 'hidden' && report();
  const offVis = listen(globalThis.document, 'visibilitychange', onHidden, true);
  const offHide = listen(globalThis, 'pagehide', report, true);
  return () => {
    offVis();
    offHide();
    observers.forEach((o) => o.disconnect());
  };
}

const CLICKABLE = 'a,button,[role=button],input[type=button],input[type=submit],input[type=reset],[data-zcb-track]';

interface ElementLike {
  tagName: string;
  id?: string;
  className?: unknown;
  textContent?: string | null;
  closest(sel: string): ElementLike | null;
  querySelector?(sel: string): unknown;
  getAttribute(name: string): string | null;
}

function selectorOf(el: ElementLike): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('') : '';
  return `${tag}${id}${cls}`.slice(0, 128);
}

/** `element_click` autocapture; returns the teardown. Never reads input values. */
export function startClicks(track: Track, mode: true | 'attribute' = true): () => void {
  return listen(globalThis.document, 'click', (ev: Event) => {
    try {
      const target = ev.target as Partial<ElementLike> | null;
      if (typeof target?.closest !== 'function') return;
      const el = target.closest(mode === 'attribute' ? '[data-zcb-track]' : CLICKABLE);
      if (!el || el.closest('[data-zcb-no-track]')) return;
      const tag = el.tagName.toLowerCase();
      const props: Record<string, unknown> = { tag, selector: selectorOf(el), path: currentPath() };
      // Visible text of links / buttons / marked elements only; never form fields or anything containing one.
      if (!/^(input|textarea|select)$/.test(tag) && !el.querySelector?.('input,textarea,select,[contenteditable]')) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 64);
        if (text) props.text = text;
      }
      const href = tag === 'a' ? originPath((el as unknown as { href?: string }).href) : '';
      if (href) props.href = href;
      const label = el.getAttribute('data-zcb-track');
      if (label) props.label = label.slice(0, 64);
      track('element_click', props);
    } catch {
      // never break the host
    }
  }, true);
}
