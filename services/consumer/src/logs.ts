import { LogEntryInput, PRODUCT_ID_RE, isEnvironment, type LogQueueMessage } from '@z-cloudbase/contracts';
import { batchId, datePath, groupBy, toNdjson } from './archive.ts';

function parseLogMessage(body: unknown): LogQueueMessage | null {
  const m = body as Partial<LogQueueMessage> | null;
  if (!m || typeof m.product_id !== 'string' || !PRODUCT_ID_RE.test(m.product_id) || !isEnvironment(m.environment)) return null;
  if ((m.source !== 'server' && m.source !== 'browser') || typeof m.ingest_request_id !== 'string') return null;
  if (typeof m.received_at !== 'string' || Number.isNaN(Date.parse(m.received_at))) return null;
  const entry = LogEntryInput.safeParse(m.entry);
  return entry.success ? { ...(m as LogQueueMessage), entry: entry.data } : null;
}

/**
 * Logs → NDJSON in the partitioned archive + `log_index` rows (PRD §4.4, §9). One object per
 * (product, env, hour) group; a failing group retries its own messages only, the rest are acked.
 * Malformed messages are retried so that they end up in the DLQ archive rather than vanishing.
 */
export async function handleLogs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const valid: Array<{ msg: Message<unknown>; log: LogQueueMessage }> = [];
  for (const msg of batch.messages) {
    const log = parseLogMessage(msg.body);
    if (log) valid.push({ msg, log });
    else {
      console.error(JSON.stringify({ msg: 'malformed log message', id: msg.id }));
      msg.retry();
    }
  }

  const groups = groupBy(valid, ({ log }) => `${log.product_id}/${log.environment}/${datePath(log.received_at, true)}`);
  for (const [prefix, items] of groups) {
    try {
      const key = `logs/${prefix}/${await batchId(items.map((i) => i.msg.id))}.ndjson`;
      await env.ARCHIVE.put(key, toNdjson(items.map((i) => i.log)));
      // Delete-then-insert in one transaction keeps a redelivered group from indexing twice.
      const index = new Set<string>();
      const stmts = [env.INGEST_DB.prepare('DELETE FROM log_index WHERE archive_key = ?').bind(key)];
      for (const { log } of items) {
        const at = Date.parse(log.entry.timestamp);
        for (const requestId of [log.entry.request_id, log.ingest_request_id]) {
          if (!requestId) continue;
          const id = `${requestId}|${log.entry.level}|${at}`;
          if (index.has(id)) continue;
          index.add(id);
          stmts.push(
            env.INGEST_DB.prepare('INSERT INTO log_index (product_env_id, request_id, occurred_at, level, archive_key) VALUES (?, ?, ?, ?, ?)')
              .bind(`${log.product_id}.${log.environment}`, requestId, at, log.entry.level, key),
          );
        }
      }
      await env.INGEST_DB.batch(stmts);
      for (const { msg } of items) msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: 'log batch failed', group: prefix, error: String(err) }));
      for (const { msg } of items) msg.retry();
    }
  }
}
