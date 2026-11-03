// `pnpm dev [--persist-to .wrangler-state] [--port 8787] [--console-port 5173] [--admin-email admin@localhost.test]`
//
// LOCAL ONLY. One command for interactive development: the three workers in one local process
// (tests/e2e/local-stack, Miniflare state kept in --persist-to), migrations, the first administrator
// (random password, printed once, on the first run), and the console's Vite dev server pointed at it.
// Ctrl-C stops everything. Ports are fixed (the OIDC issuer and the console redirect URI must stay the
// same between runs); a local AUTH_SECRET is kept in <state>/dev-secrets.json so signing keys survive restarts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bootstrapRunning, DEFAULT_ADMIN_EMAIL } from '../tests/e2e/local-stack/bootstrap.ts';
import { applyMigrations, startStack, ROOT } from '../tests/e2e/local-stack/stack.ts';

const { values } = parseArgs({
  options: {
    'persist-to': { type: 'string', default: '.wrangler-state' },
    port: { type: 'string', default: '8787' },
    'console-port': { type: 'string', default: '5173' },
    'admin-email': { type: 'string', default: DEFAULT_ADMIN_EMAIL },
  },
});
const persistTo = path.resolve(process.env.INIT_CWD ?? process.cwd(), values['persist-to']!);
const port = Number(values.port);
const consolePort = Number(values['console-port']);
const consoleOrigin = `http://localhost:${consolePort}`;

/** AUTH_SECRET encrypts the identity worker's signing keys in the state: it must survive restarts. */
function localSecret(): string {
  const file = path.join(persistTo, 'dev-secrets.json');
  if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { authSecret: string }).authSecret;
  const authSecret = randomBytes(32).toString('hex');
  writeFileSync(file, JSON.stringify({ authSecret }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return authSecret;
}

function viteBin(): string {
  const require = createRequire(path.join(ROOT, 'apps/console/package.json'));
  const pkg = require.resolve('vite/package.json');
  return path.join(path.dirname(pkg), (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: { vite: string } }).bin.vite);
}

async function main() {
  mkdirSync(persistTo, { recursive: true });
  console.log(`state: ${persistTo}`);
  await applyMigrations(persistTo);
  console.log('migrations applied (platform + ingest)');
  console.log('starting the local stack (identity + api + consumer)…');
  const stack = await startStack({ persistTo, logFile: path.join(persistTo, 'wrangler.log'), port, authSecret: localSecret() });

  let vite: ChildProcess | undefined;
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log('\nstopping…');
    if (vite?.pid) {
      try {
        process.kill(-vite.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await stack.stop();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    const r = await bootstrapRunning(stack, { consoleOrigin, adminEmail: values['admin-email']! });
    if (r.admin) {
      console.log(`\nAdministrator created (shown once, store it now):\n  email:    ${r.admin.email}\n  password: ${r.admin.password}`);
    } else {
      console.log('\nAdministrator already exists (the password was shown on the first run; to start over delete the state directory).');
    }
    vite = spawn(process.execPath, [viteBin(), '--port', String(consolePort), '--strictPort'], {
      cwd: path.join(ROOT, 'apps/console'),
      env: { ...process.env, VITE_ISSUER: stack.issuer, VITE_API_ORIGIN: stack.apiOrigin },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    vite.on('exit', (code) => {
      if (!stopping) {
        console.error(`console dev server exited (${code}); stopping`);
        void shutdown(1);
      }
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    await shutdown(1);
  }

  console.log(`\nReady (Ctrl-C stops everything):\n  console   ${consoleOrigin}\n  identity  ${stack.issuer}   (discovery: ${stack.issuer}/.well-known/openid-configuration)\n  api       ${stack.apiOrigin}   (${stack.apiOrigin}/health)\n  log       ${stack.logFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
