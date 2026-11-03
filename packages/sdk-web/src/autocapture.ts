import type { ClientConfig, KeyValueStore } from './config.ts';

export interface AutocaptureOptions {
  /** Emit `page_view` on init and on pushState / replaceState / popstate / hashchange. Default false. */
  pageViews?: boolean;
  /** Rotate `session_id` after 30 minutes without a tracked event and emit `session_start`. Default false. */
  sessions?: boolean;
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
    const pathOf = () => location.pathname + location.search + location.hash;
    let lastPath: string | null = null;
    let lastHref = '';
    const capture = () => {
      try {
        const path = pathOf();
        if (path === lastPath) return;
        const referrer = lastPath === null ? (globalThis.document?.referrer ?? '') : lastHref;
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
