# Contributing

Thanks for helping. The short version: read the spec, change the spec first if behavior changes, add tests, never
touch a real Cloudflare account from tests.

## Setup

Requirements: Node.js >= 22.18 (CI uses 24), pnpm 12 (the exact version is in `packageManager`).

```sh
pnpm install
pnpm dev          # local stack + console with persisted state (.wrangler-state); prints the admin password once
```

## Commands

```sh
pnpm -r typecheck
pnpm -r test              # unit tests (Node) and workerd integration tests
pnpm test:scripts         # operator script tests (node --test)
pnpm test:e2e             # all workers in one local process (~75 s, fresh state)
pnpm sdk:pack             # build the SDK tarballs
pnpm platform:deploy --dry-run   # generate deploy configs and build, nothing remote
```

[CLAUDE.md](CLAUDE.md) has the conventions (structure, toolchain pins such as vitest 4, Node type-stripping limits of
`scripts/*.ts`, console UI rules). It is written in Chinese; the commands above are the same.

## Rules

- **PRD first.** `z-cloudbase-prd-v3.0.md` is the single source of requirements, defaults, limits and error codes.
  A change in behavior starts as a change to the PRD, then the code. Contract changes (`packages/contracts`) update
  every caller and the SDKs; SDK public API changes update `docs/integration-guide.md` (and the `.en.md` translation)
  and bump the SDK version.
- **Isolation tests.** Every new route needs a cross-product test: a token of product A must get 401/403 on product B
  without leaking information. `product_id` / `env` / `user_id` come only from verified credentials, never from the
  request body. Prefer end-to-end tests (`tests/e2e`) for auth and isolation.
- **No remote operations in tests or CI.** Tests run on Miniflare (`--local`). Nothing in this repository's tests may
  call a real Cloudflare account, mail provider or OAuth provider; scripts that do (`platform:*`) are operator tools
  and must keep a `--dry-run` or a fake runner for their tests.
- **No secrets in the repository**, logs or docs. No brand, domain or account id of a particular deployment in code.
- No self-made OAuth / OIDC or password hashing: use the auth engine.
- Keep changes focused; update the CHANGELOG `Unreleased` section for user-visible changes.

## Pull requests

Small, focused PRs with a description of the why. CI (typecheck, tests, e2e, SDK pack) must pass. Conventional commit
messages are appreciated (`feat(api): …`, `fix(identity): …`, `docs: …`).

## Security issues

Do not file them as issues: see [SECURITY.md](SECURITY.md).
