// DLQ consumers persist dead letters to the archive; replay re-enqueues them (PRD §9).
import { env as baseEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { replayDlq } from '../src/dlq.ts';
import { ConsumerOps } from '../src/index.ts';
import { deliver, logMessage } from './helpers.ts';

const queue = () => {
  const bodies: unknown[] = [];
  return { bodies, sendBatch: async (msgs: Array<{ body: unknown }>) => void bodies.push(...msgs.map((m) => m.body)) };
};
const keys = async (prefix: string) => (await baseEnv.ARCHIVE.list({ prefix })).objects.map((o) => o.key);

describe('DLQ archive + replay', () => {
  it('persists dead-lettered messages under dlq/{queue}/{date}/{id}.json and acks them', async () => {
    const body = { product_id: 'dl_a', hello: 'world' };
    const r = await deliver('z-cloudbase-events-dlq', [body]);
    expect(r.acked).toHaveLength(1);
    const [key] = await keys('dlq/z-cloudbase-events-dlq/');
    expect(key).toMatch(/^dlq\/z-cloudbase-events-dlq\/\d{4}-\d{2}-\d{2}\/.+\.json$/);
    expect(await (await baseEnv.ARCHIVE.get(key!))!.json()).toMatchObject({ queue: 'z-cloudbase-events-dlq', body, attempts: 1 });
  });

  it('retries (does not ack) when the archive write fails', async () => {
    const broken = { ...baseEnv, ARCHIVE: { put: async () => { throw new Error('r2 down'); } } };
    const r = await deliver('z-cloudbase-logs-dlq', [{ x: 1 }], broken);
    expect(r.acked).toEqual([]);
    expect(r.retried).toHaveLength(1);
  });

  it('replays archived messages onto the original queue and removes them from the archive', async () => {
    await deliver('z-cloudbase-logs-dlq', [{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await keys('dlq/z-cloudbase-logs-dlq/')).toHaveLength(3);

    const logs = queue();
    const events = queue();
    const replayed = await replayDlq({ ...baseEnv, LOGS_QUEUE: logs, EVENTS_QUEUE: events } as any, 'z-cloudbase-logs-dlq');
    expect(replayed).toBe(3);
    expect((logs.bodies as Array<{ n: number }>).map((b) => b.n).sort()).toEqual([1, 2, 3]);
    expect(events.bodies).toEqual([]);
    expect(await keys('dlq/z-cloudbase-logs-dlq/')).toEqual([]);
    // The events DLQ archive is untouched by a logs replay.
    expect(await keys('dlq/z-cloudbase-events-dlq/')).toHaveLength(1);
    expect(await replayDlq({ ...baseEnv, LOGS_QUEUE: logs } as any, 'z-cloudbase-logs-dlq')).toBe(0);
  });

  it('replays only the requested date and keeps the archive object when the re-enqueue fails', async () => {
    await baseEnv.ARCHIVE.put('dlq/z-cloudbase-events-dlq/2020-01-01/old.json', JSON.stringify({ body: { old: true } }));
    const events = queue();
    expect(await replayDlq({ ...baseEnv, EVENTS_QUEUE: events } as any, 'z-cloudbase-events-dlq', { date: '2020-01-01' })).toBe(1);
    expect(events.bodies).toEqual([{ old: true }]);
    expect(await keys('dlq/z-cloudbase-events-dlq/2020-01-01/')).toEqual([]);
    expect(await keys('dlq/z-cloudbase-events-dlq/')).toHaveLength(1); // today's untouched

    const down = { sendBatch: async () => { throw new Error('queue down'); } };
    await expect(replayDlq({ ...baseEnv, EVENTS_QUEUE: down } as any, 'z-cloudbase-events-dlq')).rejects.toThrow('queue down');
    expect(await keys('dlq/z-cloudbase-events-dlq/')).toHaveLength(1);
  });

  it('routes environment-prefixed queue names (cloudbase-staging-*) like the local ones', async () => {
    const logs = await deliver('cloudbase-staging-logs', [logMessage('qn_a', 'prod')]);
    expect(logs.acked).toHaveLength(1);
    expect(logs.retryAll).toBe(false);
    const dead = await deliver('cloudbase-staging-events-dlq', [{ product_id: 'qn_a' }]);
    expect(dead.acked).toHaveLength(1);
    expect(await keys('dlq/cloudbase-staging-events-dlq/')).toHaveLength(1);
    const events = queue();
    expect(await replayDlq({ ...baseEnv, EVENTS_QUEUE: events } as any, 'cloudbase-staging-events-dlq')).toBe(1);
    expect(events.bodies).toEqual([{ product_id: 'qn_a' }]);
  });

  it('routes the queue names of a deployment with its own resource prefix', async () => {
    const logs = await deliver('acme-prod-logs', [logMessage('qn_p', 'prod')]);
    expect(logs.acked).toHaveLength(1);
    const dead = await deliver('acme-prod-events-dlq', [{ product_id: 'qn_p' }]);
    expect(dead.acked).toHaveLength(1);
    expect(await keys('dlq/acme-prod-events-dlq/')).toHaveLength(1);
  });

  it('retries a batch from a queue it does not know', async () => {
    const r = await deliver('someone-elses-queue', [{ x: 1 }]);
    expect(r.acked).toEqual([]);
    expect(r.retryAll).toBe(true);
  });

  it('ConsumerOps (service-binding entrypoint) replays a known DLQ and rejects anything else', async () => {
    const ops = new ConsumerOps(createExecutionContext(), baseEnv);
    await expect(ops.replayDlq('z-cloudbase-logs')).rejects.toThrow('Unknown DLQ');
    await expect(ops.replayDlq('z-cloudbase-events-dlq', { date: '../x' })).rejects.toThrow('yyyy-mm-dd');
    await expect(ops.replayDlq('z-cloudbase-logs-dlq', { date: '1999-01-01' })).resolves.toBe(0);
    await expect(ops.replayDlq('cloudbase-staging-logs-dlq', { date: '1999-01-01' })).resolves.toBe(0);
    await expect(ops.replayDlq('cloudbase-staging-logs')).rejects.toThrow('Unknown DLQ');
  });
});
