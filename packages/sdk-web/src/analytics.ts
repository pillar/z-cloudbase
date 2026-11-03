import {
  EVENTS_MAX_BATCH_BYTES, EVENTS_MAX_PER_BATCH, EVENT_MAX_PROPERTIES_BYTES, EVENT_MAX_PROPERTIES_KEYS,
  EVENT_NAME_RE, type EventBatchResponse, type EventInput,
} from '@z-cloudbase/contracts';
import type { Auth } from './auth.ts';
import { validateConfig, type ClientConfig, type KeyValueStore } from './config.ts';
import { PlatformError } from './errors.ts';
import { createHttp } from './http.ts';
import type { SessionTracker } from './autocapture.ts';

export interface AnalyticsOptions {
  /** Fraction of events kept, 0..1 (default 1). */
  sampleRate?: number;
  /** Periodic flush interval, default 5s. */
  flushIntervalMs?: number;
  /** Retries per batch for network errors / retryable responses, default 3. */
  maxRetries?: number;
  /** Where the anonymous id lives; default `localStorage`. */
  storage?: KeyValueStore;
  /** Persistent, rotating sessions that also emit `session_start` (see `autocapture.ts`). */
  session?: SessionTracker;
}

type Scalar = string | number | boolean | null;

const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Browsers cap a keepalive request body at 64 KiB. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;
/** Events kept while the API is unreachable; the oldest are dropped beyond this. */
const MAX_QUEUED = 1000;

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const isScalar = (v: unknown): v is Scalar =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Only scalar values, bounded key count and key/value length; null when the result is still too large. */
function sanitizeProperties(props: Record<string, unknown>): Record<string, Scalar> | null {
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(props)) {
    if (Object.keys(out).length >= EVENT_MAX_PROPERTIES_KEYS) break;
    if (isScalar(v)) out[k.slice(0, 64)] = typeof v === 'string' ? v.slice(0, 1024) : v;
  }
  return byteLength(JSON.stringify(out)) <= EVENT_MAX_PROPERTIES_BYTES ? out : null;
}

export function createAnalytics(
  config: ClientConfig,
  auth?: Pick<Auth, 'getAccessToken' | 'peekAccessToken'>,
  opts: AnalyticsOptions = {},
) {
  validateConfig(config);
  const http = createHttp(config, auth?.getAccessToken);
  const sampleRate = opts.sampleRate ?? 1;
  const flushIntervalMs = opts.flushIntervalMs ?? 5000;
  const maxRetries = opts.maxRetries ?? 3;
  // Keyed per product and env so a shared origin never links one product's visitor to another's.
  const anonKey = `zcb.${config.productId}.${config.env}.anonymous_id`;

  let queue: EventInput[] = [];
  let identified = false;
  let anonymousId: string | null = null;
  let sessionId: string = crypto.randomUUID();
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let listening = false;

  function store(): KeyValueStore | null {
    try {
      return opts.storage ?? globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  function getAnonymousId(): string {
    if (anonymousId) return anonymousId;
    try {
      anonymousId = store()?.getItem(anonKey) ?? null;
    } catch {
      anonymousId = null;
    }
    if (!anonymousId) {
      anonymousId = crypto.randomUUID();
      try {
        store()?.setItem(anonKey, anonymousId);
      } catch {
        // kept in memory for this page load
      }
    }
    return anonymousId;
  }

  /** Cut `queue` into batches within the count and byte limits; each event is sized once. */
  function drain(maxBytes: number): EventInput[][] {
    const batches: EventInput[][] = [];
    let cur: EventInput[] = [];
    let size = 20; // {"events":[]} envelope
    for (const ev of queue) {
      const n = byteLength(JSON.stringify(ev)) + 1;
      if (cur.length > 0 && (cur.length >= EVENTS_MAX_PER_BATCH || size + n > maxBytes)) {
        batches.push(cur);
        cur = [];
        size = 20;
      }
      cur.push(ev);
      size += n;
    }
    if (cur.length) batches.push(cur);
    queue = [];
    return batches;
  }

  function requeue(events: EventInput[]) {
    queue = [...events, ...queue].slice(-MAX_QUEUED);
  }

  /**
   * Retries happen inside `http` with the same body, so event_ids (and server dedupe) stay stable.
   * Resolves true when the batch should be kept for later; non-retryable (4xx) batches are dropped
   * because resending the same bytes cannot succeed.
   */
  async function send(events: EventInput[], o: { keepalive?: boolean } = {}): Promise<boolean> {
    try {
      const token = o.keepalive && identified ? auth?.peekAccessToken() : undefined;
      await http<EventBatchResponse>('/events/batch', {
        method: 'POST',
        body: { events },
        retries: o.keepalive ? 0 : maxRetries,
        ...(o.keepalive ? { keepalive: true } : {}),
        // identify() only opts in to the signed-in user's token; the server derives user_id from it.
        ...(token ? { token } : identified && !o.keepalive ? { auth: 'optional' as const } : {}),
      });
      return false;
    } catch (e) {
      return e instanceof PlatformError && e.retryable;
    }
  }

  function flush(o: { keepalive?: boolean } = {}): Promise<void> {
    if (o.keepalive) {
      // Must start the requests synchronously inside pagehide; no waiting on an in-flight flush.
      const batches = drain(KEEPALIVE_MAX_BYTES);
      return Promise.all(batches.map(async (b) => {
        if (await send(b, { keepalive: true })) requeue(b);
      })).then(() => undefined);
    }
    chain = chain.then(async () => {
      const batches = drain(EVENTS_MAX_BATCH_BYTES);
      for (const [i, batch] of batches.entries()) {
        if (await send(batch)) {
          // Still failing after retries: keep this and the rest for the next periodic flush.
          requeue(batches.slice(i).flat());
          break;
        }
      }
    });
    return chain;
  }

  function start() {
    if (!timer && flushIntervalMs > 0) {
      timer = setInterval(() => void flush(), flushIntervalMs);
      (timer as { unref?: () => void }).unref?.();
    }
    if (!listening && typeof document !== 'undefined') {
      listening = true;
      document.addEventListener('visibilitychange', onVisibility);
      globalThis.addEventListener?.('pagehide', onPageHide);
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush({ keepalive: true });
  };
  const onPageHide = () => void flush({ keepalive: true });

  return {
    /** Queue an event. Never throws; invalid names/properties are dropped. */
    track(name: string, properties: Record<string, unknown> = {}): void {
      try {
        if (!EVENT_NAME_RE.test(name)) return;
        const props = sanitizeProperties(properties);
        if (!props) return;
        const now = Date.now();
        let startsSession = false;
        if (opts.session) {
          const s = opts.session.touch(now);
          sessionId = s.id;
          startsSession = s.isNew;
        } else if (now - lastActivity > SESSION_IDLE_MS) sessionId = crypto.randomUUID();
        lastActivity = now;
        const add = (event_name: string, properties: Record<string, Scalar>) => {
          if (sampleRate < 1 && Math.random() >= sampleRate) return;
          queue.push({
            event_id: crypto.randomUUID(), // generated once; a retry resends the same id
            event_name,
            occurred_at: new Date(now).toISOString(),
            anonymous_id: getAnonymousId(),
            session_id: sessionId,
            properties,
            schema_version: 1,
          });
          if (queue.length > MAX_QUEUED) queue.shift();
        };
        if (startsSession) add('session_start', {});
        add(name, props);
        start();
        if (queue.length >= EVENTS_MAX_PER_BATCH) void flush();
      } catch {
        // analytics must never break the host app
      }
    },

    /** Attach the signed-in user's bearer token to batches. Does not (and cannot) choose a user id. */
    identify(): void {
      identified = true;
    },

    /** Forget the identity and start a new anonymous visitor and session. */
    reset(): void {
      identified = false;
      anonymousId = null;
      try {
        store()?.removeItem(anonKey);
      } catch {
        // ignore
      }
      sessionId = crypto.randomUUID();
      opts.session?.reset();
    },

    flush: (o?: { keepalive?: boolean }) => flush(o),

    /** Stop the timer and page listeners (tests, SPA teardown). */
    destroy(): void {
      if (timer) clearInterval(timer);
      timer = null;
      if (listening) {
        document.removeEventListener('visibilitychange', onVisibility);
        globalThis.removeEventListener?.('pagehide', onPageHide);
        listening = false;
      }
    },
  };
}
