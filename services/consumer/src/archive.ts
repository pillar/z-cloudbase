import { sha256Hex } from '@z-cloudbase/security';

export type QueueRole = 'logs' | 'events' | 'logsDlq' | 'eventsDlq';

// Local names are `z-cloudbase-{logs,events}[-dlq]`; a deployment uses its own resource prefix
// (`pnpm platform:deploy --prefix acme` → `acme-events`). Routing therefore goes by role suffix, never by an
// exact name.
const QUEUE_NAME_RE = /^[a-z0-9][a-z0-9-]*-(logs|events)(-dlq)?$/;

/** What a queue carries, from its name; null for a queue this consumer does not know. */
export function queueRole(name: string): QueueRole | null {
  const m = QUEUE_NAME_RE.exec(name);
  return m ? (`${m[1]}${m[2] ? 'Dlq' : ''}` as QueueRole) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `yyyy/mm/dd` (UTC) path segment; with `hour`, `yyyy/mm/dd/hh`. */
export function datePath(iso: string, hour = false): string {
  const d = new Date(iso);
  const day = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  return hour ? `${day}/${pad(d.getUTCHours())}` : day;
}

/**
 * Deterministic archive object id for a group of queue messages: a redelivered batch rewrites the same
 * object instead of leaving a duplicate behind (queue message ids are stable across retries).
 */
export async function batchId(messageIds: string[]): Promise<string> {
  return (await sha256Hex([...messageIds].sort().join(','))).slice(0, 32);
}

export const toNdjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Group `items` by `key`, preserving order. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const g = m.get(k);
    if (g) g.push(item);
    else m.set(k, [item]);
  }
  return m;
}
