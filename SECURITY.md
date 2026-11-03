# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository (GitHub Security Advisories, "private vulnerability reporting").
Include what you found, how to reproduce it, the affected version or commit, and the impact you expect.

You can expect an acknowledgement within 7 days and an assessment or fix plan within 30 days. Please give us a
reasonable time to release a fix before you disclose publicly; we credit reporters in the advisory unless asked not to.

## Supported versions

| Version | Supported |
|---|---|
| latest `0.x` release | yes (security fixes) |
| older releases | no: upgrade with `pnpm platform:deploy` |

While the project is `0.x`, only the latest release receives fixes.

## Scope

In scope: the code in this repository — the identity, api and consumer workers, the console, the SDKs, the operator
scripts — in particular authentication, token validation, cross-product isolation (a token of product A must never
reach product B), the `/setup/*` endpoints, storage presigning and secret handling.

Out of scope: your own Cloudflare account configuration, third parties (Cloudflare, Resend, Google, Apple), products
that integrate the SDKs, denial of service by traffic volume, and findings that need an already-compromised
administrator account or Cloudflare account.

## Operators

- Never commit `.dev.vars`, `.env`, `.deploy/` or generated `wrangler.*.deploy.jsonc`; they are gitignored.
- The administrator password printed by `pnpm platform:deploy` is shown once; store it in a password manager.
- `pnpm platform:reset-admin` rotates a lost administrator password using your Cloudflare login as the authority.
