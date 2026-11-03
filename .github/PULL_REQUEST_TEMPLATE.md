## What and why

<!-- One or two sentences. Link the issue or the PRD section (z-cloudbase-prd-v3.0.md §…). -->

## Checklist

- [ ] PRD updated first if behavior, defaults, limits or error codes changed
- [ ] Tests added or updated (new routes: a cross-product isolation test)
- [ ] `pnpm -r typecheck`, `pnpm -r test`, `pnpm test:scripts` pass (and `pnpm test:e2e` for auth / isolation changes)
- [ ] No secrets, real domains or account ids; no remote Cloudflare operations in tests
- [ ] Docs / CHANGELOG `Unreleased` updated where users are affected
