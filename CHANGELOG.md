# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Releases stage the SDKs on npm with trusted publishing (GitHub OIDC; no `NPM_TOKEN`); a maintainer publishes them with `npm stage approve` (2FA). The release workflow passes tarballs as `./dist-sdk/*.tgz` (npm read `dist-sdk/x.tgz` as a GitHub repository).

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
- The account data export includes second-factor metadata (TOTP on/off; passkey name, creation time, device type, backup state — never keys or codes).

### Changed

- With mail configured, email verification is required by default: unverified users of an upgraded deployment verify on their next password sign-in.
- `page_view` paths and referrers no longer include query strings.
- Event queue messages carry up to 25 events (the consumer still accepts the old single-event messages).
- `pnpm platform:reset-admin --disable-2fa` also removes passkeys.
- **Admin API (behavior change):** `GET /v1/admin/products/:id/logs` returns entries newest first and pages with a cursor: the response is `{ logs, next_before }`, and `before=<next_before>` fetches the next older page (PRD §4.4). Before, it returned the oldest entries of the window first, without paging, so recent entries could be cut off. The console Logs page shows newest first with "Load older entries".

### Security

- Adding a passkey to an account that already has TOTP or a passkey requires a second factor on the current session within 5 minutes (`SECOND_FACTOR_REQUIRED`); an added passkey is announced by mail.
- Impersonation confirmation is rate limited per IP and cancelled after 5 wrong codes (`user.impersonation.cancel`).
- Product tokens with an `act` claim cannot leave the product or delete storage objects (403 `impersonation_restricted`); audit rows record the owner as `metadata.actor_id`; support sessions only enter product environments the user signed in to.
- Impersonation sessions are never extended and are refused once the impersonation is no longer active; no token without `act` is issued at the expiry boundary; any logout ends the impersonation record (`signed_out`).
- Analytics Engine queries never interpolate values with quotes, backslashes or control characters (breakdown filters: 400; unsafe values from AE: `users: null`).
- Webhook SSRF guard also refuses 6to4, Teredo and 6to4-relay literals; failed deliveries record only the status line.

### Fixed

- Console Analytics: on phones the view is chosen from a select (the tab bar did not fit 390 px); wide tables show an edge shadow where they scroll; the Overview chart keeps its two series distinguishable with a brand color set (users in the brand color, events in a neutral gray, light and dark); no recharts "width(0) and height(0)" warnings when switching tabs (the chart is mounted only while Overview is shown).
- Console: a product's sections share one selected environment (default `prod`), remembered per browser and kept in the URL (`#/p/<id>/<section>?env=<env>`); before, Logs, Users export and Webhooks started on `dev` and Analytics on `prod`. Roles that cannot manage or export production see a note instead of a failing button (webhooks, raw event export).
- Identity pages: engine errors with a known code (wrong password, invalid code, banned, passkey second-factor rules) are shown in the page language; the support-session confirmation page and banner are bilingual and use the shared layout; refused browser navigations (rate limit, actions during a support session) get an HTML error page instead of the JSON body; light/dark styling, styled error alerts, a sign-out button on the account page.
- Console: an owner without TOTP gets an explanation and a two-factor setup link instead of the raw `mfa_required` error; webhook delivery errors are readable; retention shows `–` for periods that have not started; dialog titles no longer run under the close button on phones; favicon.
- Admin API: creating or updating a product with no redirect URI is a 400 `validation_failed` (it was a 500 from the identity RPC).
- Deploy: the Turnstile site key is kept in the deployment record across upgrades (it fell back to the local testing key while the secret stayed, so due challenges could not pass); a deployment without Turnstile no longer ships the testing key.
- Identity: each `/two-factor` attempt is counted once by the rate limit (it was counted twice).
- CI: actions pinned to commit SHAs.

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
