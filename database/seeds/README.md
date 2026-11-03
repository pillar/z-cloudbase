# Local development: stack and bootstrap

Everything here is local-only (Miniflare state in a directory of your choice). Deployments use
`pnpm platform:deploy` instead (see the README).

## Local bootstrap (`pnpm bootstrap:local`)

```sh
pnpm bootstrap:local --persist-to .wrangler-state
# optional: --admin-email admin@localhost.test (default), --console-origin http://localhost:5173 (default)
```

Against the local D1 / R2 state in `--persist-to` (`.wrangler-state/` is gitignored; any throwaway directory works) it:

1. applies both migration sets with `wrangler d1 migrations apply --local --persist-to` (`database/migrations` → `cloudbase-platform`, `database/ingest-migrations` → `cloudbase-ingest`);
2. starts the local stack for a moment (see below) and calls the identity worker's `POST /setup/install` with the stack's random `SETUP_TOKEN` — the same path a deployment uses: it registers the reserved `platform_console` OIDC client with the redirect URI `<console-origin>/`, and, when the state has no owner yet, creates the first administrator (`owner`, email verified) with a **random password that is printed once**;
3. stops the stack.

Running it again is safe: the console client's redirect URI is updated, the administrator is left unchanged. Lost the local password? Delete the state directory and bootstrap again.

The printed credentials sign in to the console wherever it points at workers running on this state. There is no single command yet that keeps the local stack running for interactive console use (the e2e suite and this script start and stop it); `pnpm --filter <worker> dev` runs one worker with its own state. TOTP is optional for administrators (`REQUIRE_ADMIN_2FA` in `services/identity/wrangler.jsonc`); an administrator can enable it on the identity domain's `/account` page.

## The local stack

`tests/e2e/local-stack/stack.ts` runs the three workers in **one** `wrangler dev` process so that D1, R2, the `IDENTITY` / `IdentityRpc` service bindings and the api → consumer queues (with their DLQs) share one Miniflare instance:

```sh
wrangler dev -c tests/e2e/local-stack/gateway/wrangler.jsonc -c services/identity/wrangler.jsonc \
  -c services/api/wrangler.jsonc -c services/consumer/wrangler.jsonc --persist-to <dir>
```

- `wrangler dev` with several `-c` only serves the **first** config over HTTP; the others are reachable only through service bindings ([multi-worker docs](https://developers.cloudflare.com/workers/development-testing/multi-workers/)). The first config is therefore a local-only gateway (never deployed) that forwards `http://localhost:<port>` to identity (`ISSUER`) and `http://127.0.0.1:<port>` to api (`API_ORIGIN`), and exposes the operator RPC that has no public route (DLQ replay).
- `--var` also reaches only the first config, so `ISSUER`, `API_ORIGIN`, `AUTH_SECRET`, `UPLOAD_SIGNING_SECRET` and `SETUP_TOKEN` (all random per start) are passed through the process environment (`CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, with an otherwise minimal environment). A `services/*/.dev.vars` file would take precedence, so the stack refuses to start while one exists. Because identity declares a `secrets` block, `wrangler dev` loads only the secrets listed there into it (`AUTH_SECRET`, `SETUP_TOKEN`).
- Scheduled handlers and D1 / R2 inspection go through wrangler's Local Explorer API on the same port (`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=cloudbase-consumer`); the primary-only `/cdn-cgi/handler/scheduled` (`--test-scheduled`) cannot reach the consumer.
- A running `wrangler dev` does not see D1 writes made by another process (`wrangler d1 execute` on the same directory): apply migrations only while the stack is stopped. The bootstrap script does so; inside a running stack the tests use the Local Explorer instead.

## Turnstile in local development

After 3 failed sign-ins (or invalid password-reset tokens) within 15 minutes for an account or an IP, the identity forms show the Turnstile widget and the engine endpoints answer 403 `forbidden` (`details.reason = turnstile_required`) until a token is sent (form field / header `cf-turnstile-response`). Locally (`DEPLOY_ENV=local`) the widget uses Cloudflare's public testing site key `1x00000000000000000000AA` and the worker accepts only the testing dummy token `XXXX.DUMMY.TOKEN.XXXX` — no request goes to Cloudflare. A deployment enables Turnstile only when it is configured (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`); without it, failed sign-ins are only rate limited. To reset the counters in a local state, delete the rows of the `auth_failures` table.
