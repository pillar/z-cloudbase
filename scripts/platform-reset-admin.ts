// `pnpm platform:reset-admin --email admin@example.com [--prefix z-cloudbase] [--disable-2fa]`
//
// Administrator password recovery that needs no mail provider: puts a fresh random SETUP_TOKEN on the
// deployment's identity worker (your Cloudflare login is the authority), calls /setup/reset-admin and
// prints the new random password once. The administrator is signed out everywhere; --disable-2fa also
// removes their TOTP and passkeys (lost authenticator). Reads the identity URL from .deploy/<prefix>.json, written
// by `pnpm platform:deploy`; pass --issuer for a deployment made from another checkout.
import { parseArgs } from 'node:util';
import { generatePassword, randomSecret, resetAdmin } from './lib/setup-client.ts';
import { PREFIX_RE, readRecord, resourceNames, wrangler } from './lib/wrangler.ts';

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      prefix: { type: 'string', default: 'z-cloudbase' },
      issuer: { type: 'string' },
      'account-id': { type: 'string' },
      'disable-2fa': { type: 'boolean', default: false },
    },
  });
  const prefix = values.prefix!;
  if (!PREFIX_RE.test(prefix)) fail('--prefix: the prefix the deployment was made with');
  if (!values.email) fail('--email is required (the administrator account)');
  const record = readRecord(prefix);
  const issuer = values.issuer ?? record?.urls.identity ?? fail(`no .deploy/${prefix}.json in this checkout: pass --issuer https://<identity host>`);
  const accountId = values['account-id'] ?? record?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};

  const token = randomSecret();
  console.log(`Putting a new SETUP_TOKEN on ${resourceNames(prefix).identity} …`);
  await wrangler(['secret', 'put', 'SETUP_TOKEN', '--name', resourceNames(prefix).identity], { input: token, env });

  const password = generatePassword();
  const r = await resetAdmin(issuer, token, { email: values.email!, password, disable2fa: values['disable-2fa']! });
  console.log(`\nNew password for ${values.email} (shown only now):\n  ${password}`);
  console.log(`All of this administrator's sessions were signed out${r.disabled_2fa ? ' and their TOTP was removed' : ''}.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
