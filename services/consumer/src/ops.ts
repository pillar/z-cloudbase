import { WorkerEntrypoint } from 'cloudflare:workers';
import { queueRole } from './archive.ts';
import { replayDlq } from './dlq.ts';

/**
 * Operator entrypoint of the consumer (PRD §9 DLQ recovery). Reachable only through a service
 * binding — never over public HTTP — so callers are platform tooling, not end users.
 */
export class ConsumerOps extends WorkerEntrypoint<Env> {
  /** Re-enqueue archived dead letters of `dlq` (optionally one `yyyy-mm-dd` partition); returns the count. */
  async replayDlq(dlq: string, opts: { date?: string } = {}): Promise<number> {
    const role = queueRole(dlq);
    if (role !== 'logsDlq' && role !== 'eventsDlq') throw new Error(`Unknown DLQ: ${dlq}`);
    if (opts.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('date must be yyyy-mm-dd');
    return replayDlq(this.env, dlq, opts.date ? { date: opts.date } : {});
  }
}
