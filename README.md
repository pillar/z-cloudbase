# z-cloudbase

[中文说明](README.zh-CN.md)

A self-hosted shared backend for **many products under one account system**, running entirely on Cloudflare (Workers, D1, R2, Queues, Analytics Engine). Like WordPress, the software is open source and each operator deploys their own copy — with their own name — into their own Cloudflare account.

One deployment gives you:

- **One user account across all your products** — a global `user_id`, single sign-on between products (standard OIDC authorization code + PKCE), email/password, guest (anonymous) accounts that can be upgraded later, optional Google / Apple.
- **Products as isolation boundaries** — every product has `dev` / `staging` / `prod` environments with their own audience, keys, memberships, storage prefix and analytics; a token of product A is rejected by product B.
- **Storage** (private per-user files through presigned R2 URLs), **logs**, **event analytics**.
- **An admin console** (products, environments, keys, team roles, users, logs, analytics, audit) and **SDKs** for the browser (`@z-cloudbase/web`) and servers (`@z-cloudbase/server`).
- **User management and product webhooks** — platform-wide bans, time-limited and audited support impersonation (tokens carry an RFC 8693 `act` claim), per-environment user CSV export, and signed webhooks ([Standard Webhooks](https://www.standardwebhooks.com/)) for user joined / upgraded / deleted / banned events, with retries and a delivery log.

What it deliberately is not: a database host. Products keep their own business databases and reference the platform's `user_id`.

```text
            ┌──────────────── your Cloudflare account ────────────────┐
 browser ──▶│ <prefix>-identity  OIDC issuer, sign-in pages, /setup/* │──▶ D1 <prefix>-platform
 product  ─▶│ <prefix>-api       /v1/* storage, logs, events, admin   │──▶ R2, Queues, D1 ingest
 backend    │ <prefix>-consumer  queue consumers, cron                │──▶ Analytics Engine
 admins  ──▶│ <prefix>-console   static admin console                 │
            └─────────────────────────────────────────────────────────┘
```

## Deploy

Requirements: a Cloudflare account, Node.js ≥ 22.18, pnpm 12.

```sh
git clone <this repository> && cd z-cloudbase
pnpm install
pnpm exec wrangler login            # or export CLOUDFLARE_API_TOKEN=…

pnpm platform:deploy --admin-email you@example.com --name "Acme Platform"
# with your own domain (a zone in the same account): adds --domain example.com
#   → https://id.example.com, https://api.example.com, https://console.example.com
# without --domain the workers get <name>.<your-subdomain>.workers.dev URLs
```

The script creates what is missing (D1, R2, Queues), applies the migrations, deploys the three workers and the console, and registers the console. On the first run it creates the administrator with a **random password and prints it once**:

```text
Administrator (the password is shown only now — store it in a password manager):
  email     you@example.com
  password  k7Qm…(24 characters)
```

Open the console URL, sign in, create your first product. To try it without touching your account, `pnpm platform:deploy --dry-run` only generates the configs and builds every worker locally.

There is no "Deploy to Cloudflare" button: it deploys one Worker per button and cannot provision service bindings, Analytics Engine or the first administrator (reasoning in PRD §21.1).

There is no "Deploy to Cloudflare" button: it deploys one Worker per button and cannot provision service bindings, Analytics Engine or the first administrator (reasoning in PRD §21.1).

### Options

| Flag | Default | |
|---|---|---|
| `--admin-email` | (asked) | First administrator; required on the first run |
| `--name` | `z-cloudbase` | Display name on sign-in pages, emails, the TOTP issuer and the console |
| `--domain` | workers.dev | Use `id.` / `api.` / `console.` custom domains of this zone |
| `--prefix` | `z-cloudbase` | Resource name prefix; deploy several platforms to one account with different prefixes |
| `--require-admin-2fa` | `false` | `true`: administrators must pass a second factor (TOTP, or a passkey sign-in) before using the console |
| `--signup-mode` | `open` | `open`: anyone can register; `invite`: only through invitations sent from the console (Invitations); `closed`: no new accounts. Outside `open`, guests and new Google / Apple / magic-link users are refused too |
| `--require-email-verification` | `true` | `false` lets users sign in with an unverified email (the only way to accept email sign-ups without mail; anyone can then register someone else's address, and `email_verified` stays `false`) |
| `--default-lang` | `en` | Language of the sign-in pages and mail when the browser asks for neither `zh` nor `en` |
| `--passkeys` / `--magic-link` | `true` | Passkey sign-in; magic-link sign-in (only shown when mail is configured) |
| `--logo-url` | | `https://` logo on the sign-in pages, in mail and in the console |
| `--primary-color` | indigo | Hex color (`#4f46e5`) for the sign-in pages, mail links and the console |
| `--tagline` | | One line (≤ 200 characters) under the sign-in title |
| `--account-id` | the only account | When your login has several accounts |
| `--location` | automatic | D1 / R2 location hint (`weur`, `enam`, …) |
| `--dry-run` | | Generate configs and build only; nothing is created or uploaded |

### Optional integrations

Set these in the environment of the deploy command; secrets are uploaded as Worker secrets and other mail settings are kept in `.deploy/<prefix>.json` (later runs that do not set them keep them). The deploy output lists what is still unconfigured.

| Variables | Enables | Without it |
|---|---|---|
| `EMAIL_FROM` + one transport: `RESEND_API_KEY` ([Resend](https://resend.com)), or `EMAIL_TRANSPORT=smtp` + `SMTP_HOST` [`SMTP_PORT`=465, `SMTP_USERNAME`, `SMTP_PASSWORD`], or `EMAIL_TRANSPORT=cloudflare` | Verification, password-reset, magic-link and invitation mail. SMTP works on Workers Free (implicit TLS only — no STARTTLS, no port 25); Cloudflare Email Service needs Workers Paid and a sending domain onboarded to it | With email verification required (default): no email/password sign-up, password reset or magic link (guests, social sign-in and the administrator work) |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | Turnstile challenge after 3 failed sign-ins | Failed sign-ins are only rate limited |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | File uploads/downloads (presigned R2 S3 URLs; an R2 API token with object read/write on `<prefix>-storage`) | Storage endpoints answer `unavailable` |
| `CF_ANALYTICS_API_TOKEN` | Analytics charts in the console (Account Analytics: Read) | Events are collected but cannot be queried |
| `GOOGLE_CLIENT_ID/SECRET`, `APPLE_CLIENT_ID/SECRET` | Social sign-in | Not offered |

### Upgrade

```sh
git pull && pnpm install
pnpm platform:deploy             # settings of the first run are in .deploy/<prefix>.json
```

Before an upgrade applies migrations to existing databases, the script records each D1 database's Time Travel bookmark in `.deploy/<prefix>.json` and prints the `wrangler d1 time-travel restore …` commands (also if a migration fails). The record also keeps the deployed `version` and git `commit`. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

### Remove a deployment

```sh
pnpm platform:destroy --prefix <prefix> --dry-run    # print the plan only
pnpm platform:destroy --prefix <prefix>              # asks you to type the prefix (non-interactive: --confirm <prefix>)
```

Deletes the workers (and their custom domains), queue consumers and queues, both D1 databases and both R2 buckets of that prefix, then `.deploy/<prefix>.json`. Wrangler cannot empty R2 buckets: a non-empty bucket gets a lifecycle rule that expires every object after one day, and you run the same command again about 24 hours later. Analytics Engine datasets cannot be deleted at all. D1 deletion is irreversible.

### Administrators

- More administrators and product roles (`owner`, `operator`, `product_admin`, `product_developer`) are managed in the console under Team.
- TOTP is optional by default; an administrator can enable it on the identity domain's `/account` page. Once enabled, it is required at every console sign-in. A passkey (added on `/account`) also counts: signing in with it satisfies the console's second-factor requirement.
- With `--signup-mode invite`, owners invite users from the console (Invitations); the link is mailed to the invited address (or shown once when no mail is configured).
- Lost password or authenticator (no mail provider needed):

  ```sh
  pnpm platform:reset-admin --email you@example.com [--disable-2fa]
  ```

  It puts a fresh one-time setup token on the identity worker (your Cloudflare login is the authority), sets a new random password, prints it once and signs that administrator out everywhere. `--disable-2fa` also removes their TOTP and passkeys.

There is no web installer and no public admin sign-up: the first administrator can only be created by whoever can deploy to the Cloudflare account.

## Integrate a product

1. In the console: create a product, set its redirect URIs and allowed origins, copy the publishable key (`pk_dev_…`), create a service key for your backend if needed.
2. Build the SDK tarballs: `pnpm sdk:pack` → `dist-sdk/z-cloudbase-web-<v>.tgz`, `z-cloudbase-server-<v>.tgz` (or install `@z-cloudbase/web` / `@z-cloudbase/server` from npm).
3. Follow the integration guide — [English](docs/integration-guide.en.md) or [中文](docs/integration-guide.md) (written so an AI coding assistant can follow it step by step).

```ts
import { createClient } from '@z-cloudbase/web';

export const platform = createClient({
  issuer: 'https://id.example.com',
  endpoint: 'https://api.example.com',
  productId: 'my_game',
  env: 'dev',
  publishableKey: 'pk_dev_…',
  redirectUri: 'http://localhost:5173/',
});
await platform.auth.signInWithRedirect({ guest: true }); // or a normal sign-in
```

## Develop

```sh
pnpm -r typecheck
pnpm -r test                     # unit + workerd integration tests
pnpm test:e2e                    # all workers in one local process (~75 s, fresh state)
pnpm dev                         # local stack + console with persisted state, first run prints the admin password once
pnpm test:scripts                # operator script tests
pnpm bootstrap:local --persist-to .wrangler-state   # local state + administrator with a random password (no servers kept running)
```

`pnpm dev` starts identity / api / consumer on http://localhost:8787 and the console on http://localhost:5173 (state in `.wrangler-state/`, gitignored; Ctrl-C stops everything). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Everything runs locally on Miniflare; tests never touch a Cloudflare account. See [CLAUDE.md](CLAUDE.md) for conventions and [database/seeds/README.md](database/seeds/README.md) for the local stack. Requirements and specifications: [z-cloudbase-prd-v3.0.md](z-cloudbase-prd-v3.0.md) (Chinese).

## Status

Early. The workers were verified in a Cloudflare deployment before this project was opened up (SSO, cross-product isolation, R2 presigning, Analytics Engine, Turnstile, Resend, console). The self-hosting script, the setup endpoints and the configurable name are covered by local tests and dry runs, but **a real `pnpm platform:deploy` has not been run from this repository yet**. Google / Apple sign-in is only tested against a mock provider. See [docs/poc-acceptance.md](docs/poc-acceptance.md) for what is and is not verified.

## License

[Apache-2.0](LICENSE)
