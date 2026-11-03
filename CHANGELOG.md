# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-04

First open-source release.

### Added

- Self-hostable platform on Cloudflare: identity worker (OIDC issuer, sign-in pages, operator `/setup/*` endpoints), api worker (`/v1/*` storage, logs, events, admin), consumer worker (queues, cron), static admin console.
- One user account across products: global `user_id`, SSO (authorization code + PKCE), email/password, guest accounts, optional Google / Apple sign-in, TOTP for administrators.
- Products with `dev` / `staging` / `prod` environments as isolation boundaries (audience, keys, memberships, storage prefix, analytics).
- `@z-cloudbase/web` and `@z-cloudbase/server` SDKs; tarballs via `pnpm sdk:pack`.
- Operator scripts: `pnpm platform:deploy` (idempotent install / upgrade), `pnpm platform:reset-admin`, `pnpm bootstrap:local`.
- Integration guide for product teams (`docs/integration-guide.md`).

[Unreleased]: https://github.com/pillar/z-cloudbase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pillar/z-cloudbase/releases/tag/v0.1.0
