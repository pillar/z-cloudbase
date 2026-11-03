import { BROWSER_ERROR_MAX_BYTES, type BrowserErrorInput } from '@z-cloudbase/contracts';
import { validateConfig, type ClientConfig } from './config.ts';
import { createHttp } from './http.ts';
import { scrub } from './scrub.ts';

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Shrink the report until its JSON fits the ingest limit: stack first, then message. */
function fitToLimit(message: string, stack: string | undefined, rest: Pick<BrowserErrorInput, 'url' | 'timestamp'>): BrowserErrorInput {
  const build = (): BrowserErrorInput => ({ message, ...(stack ? { stack } : {}), ...rest });
  const fits = () => byteLength(JSON.stringify(build())) <= BROWSER_ERROR_MAX_BYTES;
  while (stack && !fits()) stack = stack.slice(0, Math.floor(stack.length * 0.8));
  while (message.length > 1 && !fits()) message = message.slice(0, Math.floor(message.length * 0.8) || 1);
  return build();
}

export function createLogs(config: ClientConfig) {
  validateConfig(config);
  const http = createHttp(config);

  return {
    /** Report an error to the platform. Never throws; resolves once the report was sent or failed. */
    async captureError(error: unknown): Promise<void> {
      try {
        const err = error instanceof Error ? error : null;
        const message = scrub(err ? err.message || err.name : String(error)) || 'Unknown error';
        const stack = err?.stack ? scrub(err.stack).slice(0, 4096) : undefined;
        const loc = globalThis.location;
        // Origin + path only: query strings and fragments can carry tokens or PII.
        const url = loc ? `${loc.origin}${loc.pathname}`.slice(0, 1024) : undefined;
        const report = fitToLimit(message.slice(0, 2048), stack, {
          ...(url ? { url } : {}),
          timestamp: new Date().toISOString(),
        });
        await http('/logs/batch', { method: 'POST', body: { logs: [report] }, keepalive: true });
      } catch {
        // error reporting must never raise another error
      }
    },
  };
}
