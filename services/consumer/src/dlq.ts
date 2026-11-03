import { queueRole } from './archive.ts';

// Small pages keep each sendBatch under the 256 KB queue limit (messages are up to ~16 KB).
const PAGE = 10;

interface DeadLetter {
  queue: string;
  message_id: string;
  timestamp: string;
  attempts: number;
  body: unknown;
}

/** Persist dead-lettered messages to `dlq/{queue}/{date}/{id}.json` so they can be inspected and replayed. */
export async function handleDlq(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const day = msg.timestamp.toISOString().slice(0, 10);
      const letter: DeadLetter = { queue: batch.queue, message_id: msg.id, timestamp: msg.timestamp.toISOString(), attempts: msg.attempts, body: msg.body };
      await env.ARCHIVE.put(`dlq/${batch.queue}/${day}/${msg.id}.json`, JSON.stringify(letter));
      msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: 'dlq archive failed', id: msg.id, error: String(err) }));
      msg.retry();
    }
  }
}

/**
 * Re-enqueue archived dead letters onto their original queue, then delete the archive objects of the
 * messages that were sent. Operator-invoked; events are safe to replay (consumer-side idempotent),
 * logs may be archived twice. Returns how many messages were replayed.
 */
export async function replayDlq(env: Env, dlq: string, opts: { date?: string } = {}): Promise<number> {
  const role = queueRole(dlq);
  if (role !== 'logsDlq' && role !== 'eventsDlq') throw new Error(`Unknown DLQ: ${dlq}`);
  const queue = role === 'logsDlq' ? env.LOGS_QUEUE : env.EVENTS_QUEUE;
  const prefix = `dlq/${dlq}/${opts.date ? `${opts.date}/` : ''}`;
  let replayed = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix, cursor, limit: PAGE });
    const letters: Array<{ key: string; body: unknown }> = [];
    for (const { key } of page.objects) {
      const obj = await env.ARCHIVE.get(key);
      if (obj) letters.push({ key, body: ((await obj.json()) as DeadLetter).body });
    }
    if (letters.length > 0) {
      await queue.sendBatch(letters.map((l) => ({ body: l.body })));
      await env.ARCHIVE.delete(letters.map((l) => l.key));
      replayed += letters.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return replayed;
}
