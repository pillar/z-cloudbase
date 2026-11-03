// Shared helpers of the operator scripts: run the repo's own wrangler, read the JSONC worker configs,
// and the deployment record (non-secret settings) kept between runs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Wrangler's CLI entry, resolved from services/api (the version the workers are tested with). */
function wranglerBin(): string {
  const require = createRequire(path.join(ROOT, 'services/api/package.json'));
  const pkg = require.resolve('wrangler/package.json');
  const bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: Record<string, string> }).bin.wrangler!;
  return path.join(path.dirname(pkg), bin);
}

export interface RunOptions {
  /** Text written to stdin (e.g. a secret for `secret put`); never logged. */
  input?: string;
  /** Print wrangler's output live (deploys); otherwise it is only returned. */
  stream?: boolean;
  /** Extra environment (e.g. CLOUDFLARE_ACCOUNT_ID). */
  env?: Record<string, string>;
}

export class WranglerError extends Error {
  readonly output: string;
  constructor(args: string[], output: string, code: number | null) {
    super(`wrangler ${args.join(' ')} exited ${code}\n${output.trim()}`);
    this.output = output;
  }
}

/** Run wrangler non-interactively from the repo root; resolves with stdout + stderr. */
export function wrangler(args: string[], o: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd: ROOT,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d: Buffer) => {
      out += d;
      if (o.stream) process.stdout.write(d);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new WranglerError(args, out, code))));
    child.stdin.end(o.input ?? '');
  });
}

/** Parse JSONC: comments outside strings are removed (the worker configs have no trailing commas). */
export function parseJsonc<T = unknown>(text: string): T {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out) as T;
}

export const readJsonc = <T = Record<string, unknown>>(file: string) => parseJsonc<T>(readFileSync(path.join(ROOT, file), 'utf8'));

/** Non-secret settings of a deployment, so that later runs (upgrades) need no flags. */
export interface DeploymentRecord {
  prefix: string;
  name: string;
  domain: string | null;
  adminEmail: string;
  requireAdmin2fa: boolean;
  accountId: string;
  urls: { identity: string; api: string; console: string };
}

const recordPath = (prefix: string) => path.join(ROOT, '.deploy', `${prefix}.json`);

export function readRecord(prefix: string): DeploymentRecord | null {
  const file = recordPath(prefix);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DeploymentRecord) : null;
}

export function writeRecord(r: DeploymentRecord): void {
  mkdirSync(path.dirname(recordPath(r.prefix)), { recursive: true });
  writeFileSync(recordPath(r.prefix), `${JSON.stringify(r, null, 2)}\n`);
}

/** Resource names of a deployment; local development uses the prefix `z-cloudbase`. */
export function resourceNames(prefix: string) {
  return {
    identity: `${prefix}-identity`,
    api: `${prefix}-api`,
    consumer: `${prefix}-consumer`,
    console: `${prefix}-console`,
    platformDb: `${prefix}-platform`,
    ingestDb: `${prefix}-ingest`,
    storage: `${prefix}-storage`,
    archive: `${prefix}-archive`,
    logs: `${prefix}-logs`,
    events: `${prefix}-events`,
    logsDlq: `${prefix}-logs-dlq`,
    eventsDlq: `${prefix}-events-dlq`,
    dataset: `${prefix.replace(/-/g, '_')}_events`,
  };
}
export type ResourceNames = ReturnType<typeof resourceNames>;

export const PREFIX_RE = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

/** The generated config of a deployment sits next to the checked-in one, so relative paths still resolve. */
export const generatedConfig = (dir: string, prefix: string) => path.join(dir, `wrangler.${prefix}.deploy.jsonc`);
