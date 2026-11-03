# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-04

Platform v3.1 (PRD §21). SDKs `@z-cloudbase/web` and `@z-cloudbase/server` are at 0.2.0.

### Added

- Operations: `pnpm platform:destroy` (plan, typed confirmation, R2 lifecycle for non-empty buckets); per-prefix rate-limit namespace; D1 Time Travel restore point recorded before upgrade migrations; deployed version and commit in `.deploy/<prefix>.json`; `pnpm dev` (local stack + console in one command).
- Repository: GitHub Actions CI and tag-triggered SDK release with npm provenance, Dependabot, `SECURITY.md`, `CONTRIBUTING.md`, issue/PR templates, English integration guide.
- Mail: SMTP (implicit TLS) and Cloudflare Email Service transports besides Resend (`EMAIL_TRANSPORT`).
- Sign-up policy: `SIGNUP_MODE=open|invite|closed`, `REQUIRE_EMAIL_VERIFICATION`; invitations managed by owners in the console.
- Passkeys (count as a second factor for the console) and magic-link sign-in.
- Branding (`BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`, `SIGNIN_TAGLINE`) and bilingual (zh/en) identity pages and emails.
- User administration: platform-wide ban/unban, owner-only support impersonation (TOTP step-up, 60 min, audited, `act` claim on tokens), per-environment user CSV export.
- Product webhooks (Standard Webhooks signatures, retries with backoff, delivery log, SSRF guard) and `verifyWebhook()` in the server SDK.
- Analytics collection: error, Web Vitals and click autocapture, consent (`optOut` / `optIn`), user properties, server-side `track()`, server-derived browser / OS / device / country.
- Analytics: funnels, retention cohorts, property breakdown and filters, event explorer, per-product retention settings.
- Raw event archive in R2 (gzip NDJSON by date / product / env) with NDJSON / CSV export.

### Changed

- With mail configured, email verification is required by default: unverified users of an upgraded deployment verify on their next password sign-in.
- `page_view` paths and referrers no longer include query strings.
- Event queue messages carry up to 25 events (the consumer still accepts the old single-event messages).
- `pnpm platform:reset-admin --disable-2fa` also removes passkeys.

### Security

- Adding a passkey to an account that already has TOTP or a passkey requires a second factor on the current session within 5 minutes (`SECOND_FACTOR_REQUIRED`); an added passkey is announced by mail.
- Impersonation confirmation is rate limited per IP and cancelled after 5 wrong codes (`user.impersonation.cancel`).
- Product tokens with an `act` claim cannot leave the product or delete storage objects (403 `impersonation_restricted`); audit rows record the owner as `metadata.actor_id`; support sessions only enter product environments the user signed in to.
- Impersonation sessions are never extended and are refused once the impersonation is no longer active; no token without `act` is issued at the expiry boundary; any logout ends the impersonation record (`signed_out`).
- Analytics Engine queries never interpolate values with quotes, backslashes or control characters (breakdown filters: 400; unsafe values from AE: `users: null`).
- Webhook SSRF guard also refuses 6to4, Teredo and 6to4-relay literals; failed deliveries record only the status line.

## [0.1.0] - 2026-11-04

First open-source release.

### Added

- Self-hostable platform on Cloudflare: identity worker (OIDC issuer, sign-in pages, operator `/setup/*` endpoints), api worker (`/v1/*` storage, logs, events, admin), consumer worker (queues, cron), static admin console.
- One user account across products: global `user_id`, SSO (authorization code + PKCE), email/password, guest accounts, optional Google / Apple sign-in, TOTP for administrators.
- Products with `dev` / `staging` / `prod` environments as isolation boundaries (audience, keys, memberships, storage prefix, analytics).
- `@z-cloudbase/web` and `@z-cloudbase/server` SDKs; tarballs via `pnpm sdk:pack`.
- Operator scripts: `pnpm platform:deploy` (idempotent install / upgrade), `pnpm platform:reset-admin`, `pnpm bootstrap:local`.
- Integration guide for product teams (`docs/integration-guide.md`).

[Unreleased]: https://github.com/pillar/z-cloudbase/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pillar/z-cloudbase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pillar/z-cloudbase/releases/tag/v0.1.0
