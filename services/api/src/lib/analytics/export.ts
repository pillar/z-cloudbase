import { ApiError, EXPORT_MAX_OBJECTS } from '@z-cloudbase/contracts';
import { DAY_MS } from './range.ts';

// Raw event export from the R2 archive (PRD §21.9). Layout written by the consumer:
// events/v2/{yyyy}/{mm}/{dd}/{product}/{env}/{batch}.ndjson.gz, one JSON event per line.

const pad = (n: number) => String(n).padStart(2, '0');
export function archivePrefix(day: number, productId: string, env: string): string {
  const d = new Date(day * DAY_MS);
  return `events/v2/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${productId}/${env}/`;
}

export const CSV_COLUMNS = [
  'event_id', 'event_name', 'occurred_at', 'received_at', 'user_key', 'anonymous_id', 'session_id',
  'source', 'browser', 'os', 'device', 'country', 'properties',
] as const;

/** RFC 4180 cell; cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(e: Record<string, unknown>): string {
  const ctx = (e.context ?? {}) as Record<string, unknown>;
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    event_id: e.event_id, event_name: e.event_name, occurred_at: e.occurred_at, received_at: e.received_at, user_key: e.user_key,
    anonymous_id: e.anonymous_id, session_id: e.session_id, source: ctx.source, browser: ctx.browser, os: ctx.os, device: ctx.device,
    country: ctx.country, properties: e.properties ?? {},
  };
  return CSV_COLUMNS.map((c) => csvCell(values[c])).join(',');
}

export interface ExportInput {
  productId: string;
  env: string;
  fromDay: number;
  toDay: number;
  format: 'ndjson' | 'csv';
}

/** Archive keys of the range, day by day; more than EXPORT_MAX_OBJECTS is refused before any data is read. */
export async function listExportObjects(bucket: R2Bucket, q: ExportInput): Promise<Array<{ day: number; keys: string[] }>> {
  const days: Array<{ day: number; keys: string[] }> = [];
  let total = 0;
  for (let day = q.fromDay; day < q.toDay; day++) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: archivePrefix(day, q.productId, q.env), cursor });
      keys.push(...page.objects.map((o) => o.key));
      total += page.objects.length;
      if (total > EXPORT_MAX_OBJECTS) {
        throw new ApiError('payload_too_large', `The range holds more than ${EXPORT_MAX_OBJECTS} archive objects; export a shorter range`);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (keys.length > 0) days.push({ day, keys });
  }
  return days;
}

/**
 * Stream the export: objects are read one at a time, decompressed, filtered (suppressed user_keys of deleted
 * users, PRD §21.9) and de-duplicated by event_id within each day (the archive is at-least-once).
 */
export function exportStream(bucket: R2Bucket, days: Array<{ day: number; keys: string[] }>, suppressed: Set<string>, format: 'ndjson' | 'csv') {
  const queue = days.flatMap(({ day, keys }) => keys.map((key) => ({ day, key })));
  const enc = new TextEncoder();
  let i = 0;
  let currentDay = -1;
  let seen = new Set<string>();
  let started = false;
  const counts = { events: 0, objects: 0 };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        if (format === 'csv') {
          controller.enqueue(enc.encode(`${CSV_COLUMNS.join(',')}\n`));
          return;
        }
      }
      if (i >= queue.length) {
        controller.close();
        return;
      }
      const { day, key } = queue[i++]!;
      if (day !== currentDay) (currentDay = day), (seen = new Set());
      const obj = await bucket.get(key);
      if (!obj) return;
      counts.objects++;
      const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text();
      let out = '';
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = String(e.event_id);
        if (seen.has(id) || (typeof e.user_key === 'string' && suppressed.has(e.user_key))) continue;
        seen.add(id);
        counts.events++;
        out += `${format === 'csv' ? csvRow(e) : line}\n`;
      }
      if (out) controller.enqueue(enc.encode(out));
    },
  });
  return { stream, counts };
}

export async function suppressedKeys(db: D1Database, productEnvId: string): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT user_key FROM archive_suppressions WHERE product_env_id = ?').bind(productEnvId).all<{ user_key: string }>();
  return new Set(results.map((r) => r.user_key));
}
