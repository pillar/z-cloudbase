// `pnpm bootstrap:local --persist-to <dir> [--admin-email admin@localhost.test] [--console-origin http://localhost:5173]`
// LOCAL ONLY. Against the local state in <dir>: applies both D1 migration sets, then starts the local
// stack for a moment and calls the identity worker's /setup/install (the same path `pnpm platform:deploy` uses):
// the console client gets the redirect `<console-origin>/`, and on a state without an owner the first
// administrator is created with a random password, printed once. All steps are idempotent.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generatePassword, installPlatform } from '../../../scripts/lib/setup-client.ts';
import { applyMigrations, startStack, type StackInfo } from './stack.ts';

export const DEFAULT_ADMIN_EMAIL = 'admin@localhost.test';

/** /setup/install on a running stack; `admin` is set only when the administrator was created now. */
export async function bootstrapRunning(stack: StackInfo, o: { consoleOrigin: string; adminEmail?: string; adminPassword?: string }) {
  const adminEmail = o.adminEmail ?? DEFAULT_ADMIN_EMAIL;
  const adminPassword = o.adminPassword ?? generatePassword();
  const r = await installPlatform(stack.issuer, stack.setupToken, {
    adminEmail,
    adminPassword,
    consoleRedirectUris: [`${o.consoleOrigin.replace(/\/+$/, '')}/`],
  });
  return r.admin === 'created'
    ? { consoleClient: r.console_client, admin: { email: adminEmail, password: adminPassword, userId: r.user_id } }
    : { consoleClient: r.console_client, admin: null };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'persist-to': { type: 'string' },
      'admin-email': { type: 'string', default: DEFAULT_ADMIN_EMAIL },
      'console-origin': { type: 'string', default: 'http://localhost:5173' },
    },
  });
  if (!values['persist-to']) {
    console.error('usage: pnpm bootstrap:local --persist-to <dir> [--admin-email admin@localhost.test] [--console-origin http://localhost:5173]');
    process.exit(2);
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const persistTo = path.resolve(cwd, values['persist-to']);
  mkdirSync(persistTo, { recursive: true });

  await applyMigrations(persistTo);
  console.log(`migrations applied (platform + ingest) in ${persistTo}`);
  const stack = await startStack({ persistTo, logFile: path.join(persistTo, 'bootstrap-wrangler.log') });
  try {
    const r = await bootstrapRunning(stack, { consoleOrigin: values['console-origin']!, adminEmail: values['admin-email']! });
    console.log(`console client ${r.consoleClient.clientId} -> ${values['console-origin']}/`);
    if (r.admin) {
      console.log(`\nAdministrator created (shown once, store it now):\n  email:    ${r.admin.email}\n  password: ${r.admin.password}\n`);
    } else {
      console.log('administrator already exists (unchanged)');
    }
  } finally {
    await stack.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
