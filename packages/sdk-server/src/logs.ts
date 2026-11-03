import {
  LOGS_MAX_BATCH_BYTES, LOGS_MAX_PER_BATCH, LOG_MAX_ATTRIBUTE_KEYS, LOG_MAX_ENTRY_BYTES,
  type LogEntryInput, type LogLevel,
} from '@z-cloudbase/contracts';
import { redact } from '@z-cloudbase/security';
import { byteLength, createBatcher } from './batcher.ts';
import type { PlatformError } from './errors.ts';
import type { Http } from './http.ts';

export interface LogMeta {
  event_name?: string;
  request_id?: string;
  trace_id?: string;
}

type Scalar = string | number | boolean | null;

/** Attributes must be scalars; anything else is stringified so the entry is not rejected. */
function toScalar(v: unknown): Scalar | undefined {
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
    return typeof v === 'string' ? v.slice(0, 2048) : v;
  }
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  try {
    return JSON.stringify(v)?.slice(0, 2048);
  } catch {
    return '[unserializable]';
  }
}

export function createLogs(
  http: Http, opts: { flushIntervalMs?: number | undefined; onError?: ((e: PlatformError) => void) | undefined },
) {
  const batcher = createBatcher<LogEntryInput>({
    send: (logs) => http('/logs/batch', { method: 'POST', body: { logs }, retries: 3 }),
    maxItems: LOGS_MAX_PER_BATCH,
    maxBytes: LOGS_MAX_BATCH_BYTES,
    ...opts,
  });

  function log(level: LogLevel, message: string, attributes: Record<string, unknown> = {}, meta: LogMeta = {}) {
    try {
      const attrs: Record<string, Scalar> = {};
      // redact() walks plain objects and would turn an Error into {}, so unwrap those first.
      const plain = Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, v instanceof Error ? v.message : v]));
      for (const [k, v] of Object.entries(redact(plain))) {
        if (Object.keys(attrs).length >= LOG_MAX_ATTRIBUTE_KEYS) break;
        const s = toScalar(v);
        if (s !== undefined) attrs[k.slice(0, 64)] = s;
      }
      const entry: LogEntryInput = {
        level, timestamp: new Date().toISOString(), message: message.slice(0, 4096) || '(empty)', ...meta, attributes: attrs,
      };
      let json = JSON.stringify(entry);
      if (byteLength(json) > LOG_MAX_ENTRY_BYTES) {
        // Keep the message, give up the attributes, then shorten the message.
        entry.attributes = {};
        entry.message = entry.message.slice(0, 2048);
        json = JSON.stringify(entry);
      }
      batcher.add(entry, byteLength(json) + 1);
    } catch {
      // logging must never break the caller
    }
  }

  return {
    debug: (message: string, attributes?: Record<string, unknown>, meta?: LogMeta) => log('debug', message, attributes, meta),
    info: (message: string, attributes?: Record<string, unknown>, meta?: LogMeta) => log('info', message, attributes, meta),
    warn: (message: string, attributes?: Record<string, unknown>, meta?: LogMeta) => log('warn', message, attributes, meta),
    error: (message: string, attributes?: Record<string, unknown>, meta?: LogMeta) => log('error', message, attributes, meta),
    /** Send everything buffered. Never rejects; in Workers pass it to `ctx.waitUntil`. */
    flush: () => batcher.flush(),
    stop: () => batcher.stop(),
  };
}
