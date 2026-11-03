import { PlatformError } from './errors.ts';

const ENVELOPE_BYTES = 20;
const MAX_QUEUED = 1000;

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

export interface BatcherOptions<T> {
  /** Send one batch. Retries for transient failures belong inside (see `Http`'s `retries`). */
  send(items: T[]): Promise<unknown>;
  maxItems: number;
  maxBytes: number;
  flushIntervalMs?: number | undefined;
  onError?: ((e: PlatformError) => void) | undefined;
}

/**
 * In-memory buffer that cuts items into batches within the count and byte limits. A batch that
 * keeps failing with a retryable error stays queued (same bytes) for the next flush; any other
 * failure drops it, because resending identical content cannot succeed.
 */
export function createBatcher<T>(o: BatcherOptions<T>) {
  let queue: { item: T; bytes: number }[] = [];
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;

  function cut(): T[][] {
    const batches: T[][] = [];
    let cur: T[] = [];
    let size = ENVELOPE_BYTES;
    for (const { item, bytes } of queue) {
      if (cur.length > 0 && (cur.length >= o.maxItems || size + bytes > o.maxBytes)) {
        batches.push(cur);
        cur = [];
        size = ENVELOPE_BYTES;
      }
      cur.push(item);
      size += bytes;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  function flush(): Promise<void> {
    chain = chain.then(async () => {
      const batches = cut();
      const sizes = new Map(queue.map((q) => [q.item, q.bytes]));
      queue = [];
      for (const [i, batch] of batches.entries()) {
        try {
          await o.send(batch);
        } catch (e) {
          const err = e instanceof PlatformError ? e : new PlatformError('sdk_error', String(e));
          o.onError?.(err);
          if (err.retryable) {
            queue = [...batches.slice(i).flat().map((item) => ({ item, bytes: sizes.get(item)! })), ...queue].slice(-MAX_QUEUED);
            break;
          }
        }
      }
    });
    return chain;
  }

  function start() {
    if (!timer && o.flushIntervalMs) {
      timer = setInterval(() => void flush(), o.flushIntervalMs);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  return {
    add(item: T, bytes: number): void {
      queue.push({ item, bytes });
      if (queue.length > MAX_QUEUED) queue.shift();
      start();
      if (queue.length >= o.maxItems) void flush();
    },
    flush,
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
