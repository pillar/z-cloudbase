// `pnpm platform:deploy` — install or upgrade a self-hosted deployment in your Cloudflare account.
//
//   pnpm platform:deploy --admin-email you@example.com [--name "Acme Platform"] [--domain example.com]
//                        [--prefix z-cloudbase] [--require-admin-2fa true|false] [--account-id <id>]
//                        [--location weur|eeur|apac|oc|wnam|enam] [--dry-run]
//
// Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). Every step is idempotent, so the same command
// upgrades a deployment after `git pull`; the settings of the first run are kept in .deploy/<prefix>.json
// (no secrets) and flags given later override them.
//
// 1. creates what is missing: D1 `<prefix>-platform` / `<prefix>-ingest`, R2 `<prefix>-storage` /
//    `<prefix>-archive` (storage CORS for presigned browser uploads), Queues `<prefix>-{logs,events}[-dlq]`;
// 2. writes wrangler.<prefix>.deploy.jsonc next to each worker config (gitignored) and applies migrations;
// 3. deploys identity → consumer → api → console (identity's AUTH_SECRET is generated once, on the
//    first deploy; a fresh random SETUP_TOKEN goes with every identity deploy);
// 4. calls /setup/install with that token: console redirect URI, and — only on a platform without an
//    owner — the first administrator with a random password, printed once.
//
// Optional integrations are read from the environment and uploaded as secrets when set:
//   RESEND_API_KEY + EMAIL_FROM            email (sign-up verification, password reset)
//   TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY   Turnstile after repeated failed sign-ins
//   GOOGLE_CLIENT_ID/SECRET, APPLE_CLIENT_ID/SECRET   social sign-in
//   R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY      presigned storage URLs (R2 S3 API token)
//   CF_ANALYTICS_API_TOKEN                     analytics queries (Account Analytics Read)
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { generatePassword, installPlatform, randomSecret } from './lib/setup-client.ts';
import {
  PREFIX_RE, ROOT, WranglerError, applyRateLimitNamespaces, generatedConfig, readJsonc, readRecord, resourceNames, wrangler, writeRecord,
  type DeploymentRecord, type ResourceNames, type RestorePoint,
} from './lib/wrangler.ts';

const LOCAL = resourceNames('z-cloudbase');
const WORKERS = [
  { key: 'identity', dir: 'services/identity' },
  { key: 'consumer', dir: 'services/consumer' },
  { key: 'api', dir: 'services/api' },
  { key: 'console', dir: 'apps/console' },
] as const;
type WorkerKey = (typeof WORKERS)[number]['key'];

const STORAGE_CORS = {
  rules: [{ allowed: { origins: ['*'], methods: ['GET', 'PUT', 'HEAD'], headers: ['content-type'] }, maxAgeSeconds: 3600 }],
};

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};
const step = (message: string) => console.log(`\n▸ ${message}`);
const env = (name: string) => process.env[name]?.trim() || undefined;

function options() {
  const { values } = parseArgs({
    options: {
      prefix: { type: 'string' },
      name: { type: 'string' },
      domain: { type: 'string' },
      'admin-email': { type: 'string' },
      'require-admin-2fa': { type: 'string' },
      'account-id': { type: 'string' },
      location: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const prefix = values.prefix ?? 'z-cloudbase';
  if (!PREFIX_RE.test(prefix)) fail('--prefix: 3–30 characters, lowercase letters, digits and "-", starting with a letter');
  const domain = values.domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (domain !== undefined && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) fail('--domain: a domain name such as example.com');
  const require2fa = values['require-admin-2fa'];
  if (require2fa !== undefined && !['true', 'false'].includes(require2fa)) fail('--require-admin-2fa: true or false');
  return { ...values, prefix, domain, require2fa: require2fa === undefined ? undefined : require2fa === 'true', dryRun: values['dry-run']! };
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The account every wrangler call targets: --account-id, CLOUDFLARE_ACCOUNT_ID, the record, or the only one. */
async function resolveAccount(flag: string | undefined, recorded: string | undefined): Promise<string> {
  const out = await wrangler(['whoami', '--json']).catch((e: WranglerError) =>
    fail(`not logged in to Cloudflare: run \`pnpm exec wrangler login\` (or set CLOUDFLARE_API_TOKEN)\n${e.output}`),
  );
  const accounts = (JSON.parse(out.slice(out.indexOf('{'))) as { accounts?: Array<{ id: string; name: string }> }).accounts ?? [];
  const wanted = flag ?? env('CLOUDFLARE_ACCOUNT_ID') ?? recorded;
  if (wanted) {
    if (accounts.length && !accounts.some((a) => a.id === wanted)) fail(`account ${wanted} is not available to this login`);
    return wanted;
  }
  if (accounts.length === 1) return accounts[0]!.id;
  return fail(`several accounts are available, choose one with --account-id:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`);
}

/** The account's workers.dev subdomain (`<subdomain>.workers.dev`), through the Cloudflare API with wrangler's credentials. */
async function workersSubdomain(accountId: string): Promise<string> {
  const auth = JSON.parse(await wrangler(['auth', 'token', '--json'])) as { type: string; token?: string; key?: string; email?: string };
  const headers: Record<string, string> =
    auth.type === 'api_key' ? { 'x-auth-key': auth.key!, 'x-auth-email': auth.email! } : { authorization: `Bearer ${auth.token}` };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers });
  const body = (await res.json()) as { success: boolean; result?: { subdomain?: string } };
  const sub = body.result?.subdomain;
  if (!res.ok || !body.success || !sub) {
    return fail('this account has no workers.dev subdomain yet: open Workers & Pages in the Cloudflare dashboard once, or deploy with --domain');
  }
  return sub;
}

function urlsFor(domain: string | undefined, subdomain: string, n: ResourceNames) {
  return domain
    ? { identity: `https://id.${domain}`, api: `https://api.${domain}`, console: `https://console.${domain}` }
    : {
        identity: `https://${n.identity}.${subdomain}.workers.dev`,
        api: `https://${n.api}.${subdomain}.workers.dev`,
        console: `https://${n.console}.${subdomain}.workers.dev`,
      };
}

// --- resources -------------------------------------------------------------------------------

async function d1Id(name: string): Promise<string | null> {
  try {
    const out = await wrangler(['d1', 'info', name, '--json']);
    return (JSON.parse(out.slice(out.indexOf('{'))) as { uuid: string }).uuid;
  } catch {
    return null;
  }
}

async function ensureD1(name: string, location: string | undefined): Promise<{ id: string; created: boolean }> {
  const existing = await d1Id(name);
  if (existing) return { id: existing, created: false };
  await wrangler(['d1', 'create', name, ...(location ? ['--location', location] : [])]);
  return { id: (await d1Id(name)) ?? fail(`D1 database ${name} was created but cannot be read back`), created: true };
}

/** Current D1 Time Travel bookmark (`wrangler d1 time-travel info --json`), or null with a warning. */
async function currentBookmark(db: string): Promise<string | null> {
  try {
    const out = await wrangler(['d1', 'time-travel', 'info', db, '--json']);
    const bookmark = (JSON.parse(out.slice(out.indexOf('{'))) as { bookmark?: string }).bookmark;
    if (bookmark) return bookmark;
  } catch (e) {
    console.warn(`  warning: cannot read the Time Travel bookmark of ${db}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  return null;
}

const restoreCommand = (db: string, bookmark: string) => `pnpm exec wrangler d1 time-travel restore ${db} --bookmark=${bookmark}`;

function printRestorePoint(rp: RestorePoint, log: (m: string) => void = console.log) {
  log(`  Restore points taken ${rp.at}${rp.fromCommit ? ` (before upgrading from ${rp.fromVersion ?? '?'} @ ${rp.fromCommit})` : ''}.`);
  log('  To roll the databases back (DESTRUCTIVE: overwrites current data; then deploy the earlier commit again):');
  for (const [db, b] of Object.entries(rp.bookmarks)) log(`    ${restoreCommand(db, b)}`);
}

function gitCommit(): string | undefined {
  const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status !== 0) return undefined;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';
  return head.stdout.trim() + (dirty ? '-dirty' : '');
}
const VERSION = (readJsonc<{ version?: string }>('package.json').version ?? '0.0.0');

/** Create unless `info` finds it; a create that fails for another reason than "exists" stops the run. */
async function ensure(kind: 'r2 bucket' | 'queues', name: string, location?: string): Promise<void> {
  const base = kind.split(' ');
  try {
    await wrangler([...base, 'info', name]);
  } catch {
    await wrangler([...base, 'create', name, ...(kind === 'r2 bucket' && location ? ['--location', location] : [])]);
  }
}

// --- generated configs -----------------------------------------------------------------------

/** Replace every string that is a local resource name with the deployment's name for it. */
function rename<T>(value: T, map: Map<string, string>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => rename(v, map)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v, map)])) as T;
  return value;
}

interface GenerateInput {
  names: ResourceNames;
  d1Ids: Record<string, string>;
  urls: { identity: string; api: string; console: string };
  domain: string | undefined;
  vars: Record<WorkerKey, Record<string, string>>;
}

function generate(worker: (typeof WORKERS)[number], prefix: string, g: GenerateInput): string {
  const map = new Map(Object.entries(LOCAL).map(([k, v]) => [v, g.names[k as keyof ResourceNames]]));
  const config = rename(readJsonc(`${worker.dir}/wrangler.jsonc`), map) as Record<string, any>;
  delete config.dev;
  // Secrets are managed here (AUTH_SECRET once, SETUP_TOKEN every run), not validated by wrangler.
  delete config.secrets;
  // The rate limit namespace is account-wide: derive it from the prefix so deployments do not share counters.
  applyRateLimitNamespaces(config, prefix);
  for (const db of config.d1_databases ?? []) db.database_id = g.d1Ids[db.database_name] ?? fail(`no D1 id for ${db.database_name}`);
  const vars = { ...config.vars, ...g.vars[worker.key] };
  if (Object.keys(vars).length) config.vars = vars;
  config.preview_urls = false;
  const host = worker.key === 'identity' || worker.key === 'api' || worker.key === 'console' ? new URL(g.urls[worker.key]).host : null;
  if (g.domain && host) {
    config.workers_dev = false;
    config.routes = [{ pattern: host, custom_domain: true }];
  } else {
    // workers.dev; the consumer has no public route at all.
    config.workers_dev = worker.key !== 'consumer';
  }
  const file = generatedConfig(path.join(ROOT, worker.dir), prefix);
  writeFileSync(file, `// GENERATED by scripts/platform-deploy.ts for the deployment "${prefix}". Do not edit; re-run the script.\n${JSON.stringify(config, null, 2)}\n`);
  return path.relative(ROOT, file);
}

// --- secrets ---------------------------------------------------------------------------------

/** Names of the secrets a worker already has; empty when the worker does not exist yet. */
async function secretNames(worker: string): Promise<Set<string>> {
  try {
    const out = await wrangler(['secret', 'list', '--name', worker, '--format', 'json']);
    return new Set((JSON.parse(out.slice(out.indexOf('['))) as Array<{ name: string }>).map((s) => s.name));
  } catch (e) {
    const output = e instanceof WranglerError ? e.output : String(e);
    // Never guess: generating a new AUTH_SECRET for a live worker would sign everybody out and
    // orphan its signing keys. Only a worker that does not exist gets a new one.
    if (/not found|does not exist|10007/i.test(output)) return new Set();
    return fail(`cannot list the secrets of ${worker}:\n${output}`);
  }
}

const pick = (...names: string[]) => Object.fromEntries(names.flatMap((n) => (env(n) ? [[n, env(n)!]] : [])));

// --- main ------------------------------------------------------------------------------------

async function main() {
  const o = options();
  const record = readRecord(o.prefix);
  const names = resourceNames(o.prefix);
  const name = o.name ?? record?.name ?? 'z-cloudbase';
  const domain = o.domain ?? record?.domain ?? undefined;
  const requireAdmin2fa = o.require2fa ?? record?.requireAdmin2fa ?? false;
  let adminEmail = o['admin-email'] ?? record?.adminEmail;
  if (!adminEmail && !o.dryRun) adminEmail = await ask('Administrator email: ');
  if (!adminEmail) adminEmail = o.dryRun ? 'admin@example.com' : fail('--admin-email is required for the first deployment');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) fail(`not an email address: ${adminEmail}`);

  // Both or neither: the testing site key with a real secret would lock users out once a challenge is due.
  if (Boolean(env('TURNSTILE_SITE_KEY')) !== Boolean(env('TURNSTILE_SECRET_KEY'))) fail('set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY together');
  if (Boolean(env('RESEND_API_KEY')) !== Boolean(env('EMAIL_FROM'))) fail('set RESEND_API_KEY and EMAIL_FROM together');

  console.log(`${o.dryRun ? 'Dry run of' : 'Deploying'} "${name}" (prefix ${o.prefix}${domain ? `, domain ${domain}` : ', workers.dev'})`);

  const accountId = o.dryRun ? (o['account-id'] ?? record?.accountId ?? '0'.repeat(32)) : await resolveAccount(o['account-id'], record?.accountId);
  const accountEnv = { CLOUDFLARE_ACCOUNT_ID: accountId };
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const urls = urlsFor(domain, domain || o.dryRun ? 'your-subdomain' : await workersSubdomain(accountId), names);

  const d1Ids: Record<string, string> = {};
  /** Databases that existed before this run: only those have data worth a restore point. */
  const existingDbs: string[] = [];
  if (o.dryRun) {
    d1Ids[names.platformDb] = '00000000-0000-4000-8000-000000000001';
    d1Ids[names.ingestDb] = '00000000-0000-4000-8000-000000000002';
  } else {
    step('Resources (D1, R2, Queues)');
    for (const db of [names.platformDb, names.ingestDb]) {
      const r = await ensureD1(db, o.location);
      d1Ids[db] = r.id;
      if (!r.created) existingDbs.push(db);
    }
    for (const bucket of [names.storage, names.archive]) await ensure('r2 bucket', bucket, o.location);
    for (const queue of [names.logs, names.events, names.logsDlq, names.eventsDlq]) await ensure('queues', queue);
    console.log(`  D1 ${names.platformDb}, ${names.ingestDb}; R2 ${names.storage}, ${names.archive}; Queues ${names.logs}, ${names.events} (+ DLQs)`);
  }

  const vars: GenerateInput['vars'] = {
    identity: {
      ISSUER: urls.identity,
      DEPLOY_ENV: 'production',
      PLATFORM_NAME: name,
      REQUIRE_ADMIN_2FA: String(requireAdmin2fa),
      ...(env('TURNSTILE_SITE_KEY') ? { TURNSTILE_SITE_KEY: env('TURNSTILE_SITE_KEY')! } : {}),
      ...(env('EMAIL_FROM') ? { EMAIL_FROM: env('EMAIL_FROM')! } : {}),
    },
    api: { ISSUER: urls.identity, API_ORIGIN: urls.api, DEPLOY_ENV: 'production', AE_DATASET: names.dataset },
    consumer: { DEPLOY_ENV: 'production' },
    console: {},
  };
  let restorePoint: RestorePoint | undefined;
  const baseRecord = (): DeploymentRecord => ({ prefix: o.prefix, name, domain: domain ?? null, adminEmail: adminEmail!, requireAdmin2fa, accountId, urls });
  const configs = Object.fromEntries(WORKERS.map((w) => [w.key, generate(w, o.prefix, { names, d1Ids, urls, domain, vars })])) as Record<WorkerKey, string>;
  console.log(`\n  generated ${Object.values(configs).join(', ')}`);

  if (!o.dryRun) {
    if (existingDbs.length) {
      step('Restore point (D1 Time Travel)');
      const bookmarks: Record<string, string> = {};
      for (const db of existingDbs) {
        const b = await currentBookmark(db);
        if (b) bookmarks[db] = b;
      }
      if (Object.keys(bookmarks).length) {
        restorePoint = { at: new Date().toISOString(), fromVersion: record?.version, fromCommit: record?.commit, bookmarks };
        // Persisted before the migrations run, so it survives a failed upgrade.
        writeRecord({ ...(record ?? baseRecord()), restorePoints: restorePoint });
        printRestorePoint(restorePoint);
      }
    }
    step('Migrations');
    for (const db of [names.platformDb, names.ingestDb]) {
      try {
        await wrangler(['d1', 'migrations', 'apply', db, '--remote', '-c', configs.api], { env: accountEnv });
      } catch (e) {
        if (restorePoint) {
          console.error(`\nMigration of ${db} failed. The databases can be restored to the state before this upgrade:`);
          printRestorePoint(restorePoint, console.error);
        }
        throw e;
      }
    }
    step('Storage bucket CORS (presigned browser uploads)');
    const tmp = mkdtempSync(path.join(tmpdir(), 'platform-deploy-'));
    try {
      const corsFile = path.join(tmp, 'cors.json');
      writeFileSync(corsFile, JSON.stringify(STORAGE_CORS));
      await wrangler(['r2', 'bucket', 'cors', 'set', names.storage, '--file', corsFile, '--force']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Secrets go in a private temp file for `deploy --secrets-file` (additive: omitted ones are kept).
  const setupToken = randomSecret();
  const secrets: Partial<Record<WorkerKey, Record<string, string>>> = {};
  /** Secret names the workers already have (from earlier runs), to report what is still unconfigured. */
  const configured = new Set<string>();
  if (!o.dryRun) {
    const existing = await secretNames(names.identity);
    for (const s of [...existing, ...(await secretNames(names.api))]) configured.add(s);
    secrets.identity = {
      SETUP_TOKEN: setupToken,
      ...(existing.has('AUTH_SECRET') ? {} : { AUTH_SECRET: randomSecret() }),
      ...pick('RESEND_API_KEY', 'TURNSTILE_SECRET_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APPLE_CLIENT_ID', 'APPLE_CLIENT_SECRET'),
    };
    secrets.api = {
      ...(env('R2_ACCESS_KEY_ID') && env('R2_SECRET_ACCESS_KEY')
        ? { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: names.storage, ...pick('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') }
        : {}),
      ...(env('CF_ANALYTICS_API_TOKEN') ? { CF_ACCOUNT_ID: accountId, ...pick('CF_ANALYTICS_API_TOKEN') } : {}),
    };
  }

  step('Console build');
  const build = spawnSync('pnpm', ['--filter', '@z-cloudbase/console', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_ISSUER: urls.identity, VITE_API_ORIGIN: urls.api, VITE_PLATFORM_NAME: name },
  });
  if (build.status !== 0) fail('console build failed');

  const tmp = mkdtempSync(path.join(tmpdir(), 'platform-deploy-'));
  try {
    for (const w of WORKERS) {
      step(`${o.dryRun ? 'Check' : 'Deploy'} ${w.key}`);
      const args = ['deploy', '-c', configs[w.key]];
      if (o.dryRun) args.push('--dry-run');
      const own = secrets[w.key];
      if (own && Object.keys(own).length) {
        const file = path.join(tmp, `${w.key}.json`);
        writeFileSync(file, JSON.stringify(own), { mode: 0o600 });
        chmodSync(file, 0o600);
        args.push('--secrets-file', file);
      }
      await wrangler(args, { stream: true, env: accountEnv });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (o.dryRun) {
    console.log('\nDry run complete: configs generated and every worker built; nothing was created or uploaded.');
    return;
  }

  step('Install (console client, first administrator)');
  const adminPassword = generatePassword();
  const installed = await installPlatform(urls.identity, setupToken, { adminEmail, adminPassword, consoleRedirectUris: [`${urls.console}/`] });
  const r: DeploymentRecord = {
    ...baseRecord(), version: VERSION, commit: gitCommit(), deployedAt: new Date().toISOString(),
    ...(restorePoint ? { restorePoints: restorePoint } : record?.restorePoints ? { restorePoints: record.restorePoints } : {}),
  };
  writeRecord(r);

  console.log(`\nDone. "${name}" is deployed:\n  console   ${urls.console}\n  identity  ${urls.identity}\n  api       ${urls.api}`);
  if (installed.admin === 'created') {
    console.log(`\nAdministrator (the password is shown only now — store it in a password manager):\n  email     ${adminEmail}\n  password  ${adminPassword}`);
  } else {
    console.log(`\nThe administrator already existed and was not changed. Lost the password? pnpm platform:reset-admin --prefix ${o.prefix} --email <email>`);
  }
  for (const own of Object.values(secrets)) for (const k of Object.keys(own ?? {})) configured.add(k);
  const missing = [
    !configured.has('RESEND_API_KEY') && 'email (RESEND_API_KEY + EMAIL_FROM): user sign-up and password reset mails cannot be sent',
    !configured.has('TURNSTILE_SECRET_KEY') && 'Turnstile (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY): failed sign-ins are only rate limited',
    !configured.has('R2_SECRET_ACCESS_KEY') && 'storage presigning (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY): file uploads / downloads are unavailable',
    !configured.has('CF_ANALYTICS_API_TOKEN') && 'analytics queries (CF_ANALYTICS_API_TOKEN): events are collected but the console cannot chart them',
  ].filter(Boolean);
  if (restorePoint) {
    console.log('\nD1 restore point (taken before this upgrade\'s migrations):');
    printRestorePoint(restorePoint);
  }
  if (missing.length) console.log(`\nNot configured yet (set the variables and run again):\n${missing.map((m) => `  - ${m}`).join('\n')}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
