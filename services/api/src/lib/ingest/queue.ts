import { jsonBytes } from './body.ts';

// Queues allow 100 messages / 256 KB per sendBatch; stay below the byte cap.
const MAX_CHUNK_MESSAGES = 100;
const MAX_CHUNK_BYTES = 200 * 1024;

/** Thrown when sending stops part-way; items `[0, sent)` are already on the queue. */
export class QueueSendError extends Error {
  constructor(readonly sent: number, cause: unknown) {
    super('Queue send failed', { cause });
    this.name = 'QueueSendError';
  }
}

/** Send `bodies` in order, split into queue-sized chunks. */
export async function sendInChunks(queue: Queue, bodies: unknown[]): Promise<void> {
  let sent = 0;
  while (sent < bodies.length) {
    let end = sent;
    let bytes = 0;
    while (end < bodies.length && end - sent < MAX_CHUNK_MESSAGES) {
      const size = jsonBytes(bodies[end]);
      if (end > sent && bytes + size > MAX_CHUNK_BYTES) break;
      bytes += size;
      end++;
    }
    try {
      await queue.sendBatch(bodies.slice(sent, end).map((body) => ({ body })));
    } catch (err) {
      throw new QueueSendError(sent, err);
    }
    sent = end;
  }
}
