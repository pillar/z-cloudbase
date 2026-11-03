// `pnpm platform:destroy --prefix <p> [--confirm <p>] [--account-id <id>] [--dry-run]`
//
// Deletes every resource of ONE deployment prefix: the four workers (with their custom domains and secrets),
// the queue consumers and queues, both D1 databases, both R2 buckets, and finally .deploy/<prefix>.json.
// Prints the plan first; you must type the prefix (or pass --confirm <prefix> without a terminal).
// R2 buckets must be empty to be deleted and wrangler cannot empty them: a non-empty bucket gets a
// lifecycle rule that expires all objects after 1 day, and the command is re-run later. Analytics Engine
// datasets cannot be deleted at all. Safe to re-run. `--dry-run` prints the plan and calls nothing.
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { checkConfirmation, executePlan, formatPlan, isComplete } from './lib/destroy.ts';
import { PREFIX_RE, WranglerError, readRecord, recordPath, wrangler } from './lib/wrangler.ts';

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

async function main() {
  const { values } = parseArgs({
    options: {
      prefix: { type: 'string' },
      confirm: { type: 'string' },
      'account-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const prefix = values.prefix;
  if (!prefix) fail('--prefix is required (the prefix of the deployment to delete; there is no default on purpose)');
  if (!PREFIX_RE.test(prefix!)) fail('--prefix: 3–30 characters, lowercase letters, digits and "-", starting with a letter');
  const record = readRecord(prefix!);
  const accountId = values['account-id'] ?? process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? record?.accountId;

  console.log(formatPlan(prefix!, accountId));
  if (values['dry-run']) {
    console.log('\nDry run: nothing was deleted.');
    return;
  }

  let typed: string | undefined;
  if (values.confirm === undefined && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      typed = (await rl.question(`\nThis cannot be undone. Type the prefix "${prefix}" to delete everything above: `)).trim();
    } finally {
      rl.close();
    }
  }
  const refused = checkConfirmation(prefix!, { confirmFlag: values.confirm, typed, interactive: Boolean(process.stdin.isTTY) });
  if (refused) fail(refused);

  if (!accountId) {
    const out = await wrangler(['whoami', '--json']).catch((e: WranglerError) => fail(`not logged in to Cloudflare:\n${e.output}`));
    const accounts = (JSON.parse(out.slice(out.indexOf('{'))) as { accounts?: Array<{ id: string; name: string }> }).accounts ?? [];
    if (accounts.length !== 1) fail(`choose the account with --account-id:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`);
    process.env.CLOUDFLARE_ACCOUNT_ID = accounts[0]!.id;
  } else {
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }

  console.log('\nDeleting…');
  const results = await executePlan(prefix!, (args) => wrangler(args, { env: { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID! } }), console.log);
  if (!isComplete(results)) {
    const pending = results.filter((r) => r.outcome === 'pending').length;
    const failed = results.filter((r) => r.outcome === 'failed').length;
    console.error(`\nNot finished: ${failed} failed, ${pending} waiting for an R2 bucket to empty. Run the same command again${pending ? ' in about 24 hours' : ' after fixing the errors above'}; .deploy/${prefix}.json was kept.`);
    process.exit(1);
  }
  rmSync(recordPath(prefix!), { force: true });
  console.log(`\nDone: every resource of "${prefix}" is deleted.`);
  console.log('Still to check by hand: custom-domain DNS records of the zone (id./api./console.) if the zone is yours, and the Analytics Engine dataset (cannot be deleted; it expires with its retention).');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
