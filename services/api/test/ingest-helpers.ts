// Fixtures for ingestion tests: fake queue producers and an app caller with binding overrides.
import { env as baseEnv } from 'cloudflare:workers';
import app from '../src/index.ts';
import { minter } from './helpers.ts';

export interface FakeQueue {
  /** Every message body accepted so far. */
  bodies: any[];
  /** Number of sendBatch calls that were attempted. */
  calls: number;
  sendBatch(msgs: Array<{ body: unknown }>): Promise<void>;
}

/** Queue stand-in that records messages; `failOnCall` (1-based) makes that sendBatch call throw. */
export function fakeQueue(opts: { failOnCall?: number } = {}): FakeQueue {
  const q: FakeQueue = {
    bodies: [],
    calls: 0,
    async sendBatch(msgs) {
      q.calls++;
      if (q.calls === opts.failOnCall) throw new Error('queue down');
      q.bodies.push(...msgs.map((m) => m.body));
    },
  };
  return q;
}

export type Overrides = Partial<Record<'LOGS_QUEUE' | 'EVENTS_QUEUE' | 'INGEST_LIMITER', unknown>>;

/**
 * Identity RPC stand-in serving the test minter's JWKS. Injected through the env (the api reads
 * `env.IDENTITY` via src/identity.ts), so tests don't depend on module mocking.
 */
async function withIdentity() {
  const { jwks } = await minter();
  return { getJwks: async () => jwks };
}

export function post(path: string, key: string | null, body: unknown, opts: { overrides?: Overrides; headers?: Record<string, string>; raw?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (key) headers['X-Platform-Key'] = key;
  return withIdentity().then((IDENTITY) =>
    app.request(path, { method: 'POST', headers, body: opts.raw ? (body as string) : JSON.stringify(body) }, { ...baseEnv, IDENTITY, ...opts.overrides }));
}

export const errorCode = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;
