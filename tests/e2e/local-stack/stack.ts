// Local multi-worker stack for e2e tests and `pnpm bootstrap:local`. LOCAL ONLY: every wrangler
// call below uses --local / a --persist-to directory; nothing here can reach a remote resource.
//
// Topology (one `wrangler dev` process, one Miniflare instance, shared D1 / R2 / Queues state):
//   wrangler dev -c gateway -c services/identity -c services/api -c services/consumer --persist-to <dir>
// Only the first config is served over HTTP, so a local-only gateway (./gateway) is first and forwards
// by hostname: http://localhost:<port> -> identity (ISSUER), http://127.0.0.1:<port> -> api (API_ORIGIN).
// Scheduled handlers, D1 and R2 inspection use wrangler's Local Explorer API on the same port.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIGS = [
  'tests/e2e/local-stack/gateway/wrangler.jsonc',
  'services/identity/wrangler.jsonc',
  'services/api/wrangler.jsonc',
  'services/consumer/wrangler.jsonc',
];
export const DATABASES = { platform: 'z-cloudbase-platform', ingest: 'z-cloudbase-ingest' } as const;
export type Database = keyof typeof DATABASES;

/** Wrangler's CLI entry, resolved from this package's own devDependency. */
export function wranglerBin(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('wrangler/package.json');
  const bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: Record<string, string> }).bin.wrangler!;
  return path.join(path.dirname(pkg), bin);
}

/** Only what wrangler needs to run, plus `extra`. Nothing else from the caller's environment reaches the workers. */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'USERPROFILE', 'XDG_CONFIG_HOME'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, WRANGLER_SEND_METRICS: 'false', CI: 'true', ...extra };
}

export function run(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.join(' ')} exited ${code}\n${out}`))));
  });
}

/** Apply the platform and ingest D1 migrations to the local state in `persistTo` (stack must be stopped). */
export async function applyMigrations(persistTo: string): Promise<void> {
  for (const db of Object.values(DATABASES)) {
    await run(['d1', 'migrations', 'apply', db, '--local', '--persist-to', persistTo, '-c', 'services/api/wrangler.jsonc'], childEnv({}));
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** What tests need to reach a running stack (serializable; `stop` stays with the owner). */
export type StackInfo = Omit<Stack, 'stop'>;

export interface Stack {
  port: number;
  /** Identity worker origin (OIDC issuer). */
  issuer: string;
  /** Api worker origin. */
  apiOrigin: string;
  /** Gateway origin for local-only operator calls (`/__local/*`). */
  gateway: string;
  /** SETUP_TOKEN of this run (random per start): authorizes the identity worker's /setup/* calls. */
  setupToken: string;
  logFile: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  persistTo: string;
  logFile: string;
  port?: number;
  /** Better Auth secret; a random one is generated when omitted (never committed anywhere). */
  authSecret?: string;
}

/**
 * Start identity + api + consumer (+ the local gateway) in ONE `wrangler dev` process.
 * Vars are passed through the process environment (CLOUDFLARE_INCLUDE_PROCESS_ENV), because
 * `--var` only reaches the first config; a `.dev.vars` file next to a service config would take
 * precedence and silently change ISSUER / API_ORIGIN, so its presence is an error here.
 */
export async function startStack(o: StackOptions): Promise<Stack> {
  for (const svc of ['identity', 'api', 'consumer']) {
    const devVars = path.join(ROOT, 'services', svc, '.dev.vars');
    if (existsSync(devVars)) {
      throw new Error(`${path.relative(ROOT, devVars)} exists: it would override the e2e stack's ISSUER / API_ORIGIN / secrets. Move it away while running the local stack.`);
    }
  }
  const port = o.port ?? (await freePort());
  const issuer = `http://localhost:${port}`;
  const apiOrigin = `http://127.0.0.1:${port}`;
  const setupToken = randomBytes(32).toString('hex');
  const env = childEnv({
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
    X_LOCAL_EXPLORER: 'true',
    ISSUER: issuer,
    API_ORIGIN: apiOrigin,
    AUTH_SECRET: o.authSecret ?? randomBytes(32).toString('hex'),
    UPLOAD_SIGNING_SECRET: randomBytes(32).toString('hex'),
    SETUP_TOKEN: setupToken,
  });
  const args = [
    'dev', ...CONFIGS.flatMap((c) => ['-c', c]),
    '--persist-to', o.persistTo, '--port', String(port), '--ip', '127.0.0.1',
    '--show-interactive-dev-session=false', '--inspector-port', '0',
  ];
  const log = createWriteStream(o.logFile, { flags: 'a' });
  const child: ChildProcess = spawn(process.execPath, [wranglerBin(), ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  let exited: number | null = null;
  const exitPromise = new Promise<void>((resolve) => child.on('exit', (code) => ((exited = code ?? -1), resolve())));

  const stop = async () => {
    if (exited === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 10_000);
      await exitPromise;
      clearTimeout(timer);
    }
    log.end();
  };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited !== null) throw new Error(`wrangler dev exited (${exited}) during startup; see ${o.logFile}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`local stack did not become healthy within 90s; see ${o.logFile}`);
    }
    try {
      const [a, b] = await Promise.all([fetch(`${issuer}/health`), fetch(`${apiOrigin}/health`)]);
      const [ja, jb] = [await a.json(), await b.json()] as Array<{ service?: string }>;
      if (ja?.service === 'identity' && jb?.service === 'api') break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { port, issuer, apiOrigin, gateway: apiOrigin, setupToken, logFile: o.logFile, stop };
}

async function explorer<T>(stack: StackInfo, pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${stack.gateway}/cdn-cgi/local/explorer/api${pathname}`, init);
  const body = (await res.json()) as { success: boolean; result: T; errors?: unknown };
  if (!res.ok || !body.success) throw new Error(`Local Explorer ${pathname} failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body.result;
}

/** Local database_id of a D1 database, read from services/api/wrangler.jsonc (the Local Explorer keys databases by id). */
function databaseId(name: string): string {
  const config = readFileSync(path.join(ROOT, 'services/api/wrangler.jsonc'), 'utf8');
  const m = new RegExp(`"database_name":\\s*"${name}",\\s*"database_id":\\s*"([^"]+)"`).exec(config);
  if (!m) throw new Error(`database_id of ${name} not found in services/api/wrangler.jsonc`);
  return m[1]!;
}

/**
 * Run SQL on a local D1 database inside the running stack (same Miniflare instance, consistent state).
 * The D1 API takes string parameters; SQLite column affinity converts them for INTEGER columns.
 */
export async function d1<T = Record<string, unknown>>(stack: StackInfo, db: Database, sql: string, params: Array<string | number> = []): Promise<T[]> {
  const result = await explorer<Array<{ results: { columns: string[]; rows: unknown[][] } }>>(stack, `/d1/database/${databaseId(DATABASES[db])}/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params: params.map(String) }),
  });
  const last = result[result.length - 1]?.results ?? { columns: [], rows: [] };
  return last.rows.map((row) => Object.fromEntries(last.columns.map((c, i) => [c, row[i]])) as T);
}

/** Keys under `prefix` in a local R2 bucket. */
export async function r2Keys(stack: StackInfo, bucket: string, prefix: string): Promise<string[]> {
  const objects = await explorer<Array<{ key: string }>>(stack, `/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefix)}`);
  return objects.map((o) => o.key);
}

/** Invoke the consumer's scheduled handler with `cron` (Local Explorer; the primary-only /cdn-cgi/handler/scheduled cannot reach it). */
export async function triggerCron(stack: StackInfo, cron: string): Promise<void> {
  const r = await explorer<{ outcome: string }>(stack, `/local/scheduled?worker=z-cloudbase-consumer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cron }),
  });
  if (r.outcome !== 'ok') throw new Error(`scheduled handler outcome: ${r.outcome}`);
}

async function gatewayCall<T>(stack: StackInfo, pathname: string, body: unknown): Promise<T> {
  const res = await fetch(`${stack.gateway}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${pathname} failed: ${json.error ?? res.status}`);
  return json;
}

/** Re-enqueue archived dead letters through the consumer's ConsumerOps.replayDlq. */
export async function replayDlq(stack: StackInfo, dlq: 'z-cloudbase-logs-dlq' | 'z-cloudbase-events-dlq', date?: string): Promise<number> {
  return (await gatewayCall<{ replayed: number }>(stack, '/__local/dlq/replay', { dlq, ...(date ? { date } : {}) })).replayed;
}
