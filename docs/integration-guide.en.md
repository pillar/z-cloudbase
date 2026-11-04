# Product Integration Guide (for the AI developer of a product)

> Translation of [integration-guide.md](integration-guide.md) (Chinese, the maintained original). If the two differ, the Chinese version wins.
>
> Version: SDK 0.2.2 · updated 2026-11-04
> This is the only instruction a product needs to integrate with this platform (a self-hosted instance of z-cloudbase). `https://id.example.com` / `https://api.example.com` / `https://console.example.com` below are placeholders: replace them with the addresses of your deployment (printed at the end of `pnpm platform:deploy`, or ask the platform administrator). Follow the "Execution checklist" in order; every step has a verifiable result. If you see behavior that differs from this document, record the request's `x-request-id` and the error code and report it to the platform team instead of working around it.

## 0. Execution checklist (the AI completes these in order)

1. Ask the human owner for everything in section 2, "What a human must prepare in the console"; do not start writing code while any item is missing.
2. Install the SDK (section 3) and confirm that `tsc` recognizes the types of `@z-cloudbase/web` / `@z-cloudbase/server`.
3. Add sign-in to the frontend (section 4.2): regular apps use the sign-in page, games use guest mode (section 4.3).
4. Verify with `getUser()` from section 4.4: you get a `user_id`, and `product_id` is your product.
5. As needed: analytics (4.6), error reporting (4.7), file storage (4.5), token verification on the backend (section 5).
6. Run the "Acceptance checklist" in section 8 and report the results to the human owner.

## 1. The platform model (you must understand it, or you will write the wrong thing)

| Concept | Description |
|---|---|
| Platform account `user_id` | Globally unique (like `usr_01a1…`). The same person has the same `user_id` in every product of this platform. **Use it as the foreign key of your business data.** |
| Product `product_id` | The ID of your product on the platform (e.g. `my_game`), created in the platform console. |
| Environment `env` | `dev` / `staging` / `prod`; every product has all three, with fully isolated data, keys and statistics. Use `dev` while developing. |
| Publishable key `pk_{env}_…` | Identifies "which environment of which product". **Not a secret**; it may be written into frontend code. |
| Service key `sk_{env}_…` | The credential of a backend calling the platform API. **A secret**: only in server-side environment variables, never in a browser, an app package or a repository. |
| Membership | Created automatically the first time a user signs in to a product (when the product's visibility is "public"). A "restricted" product only lets existing members sign in. |
| SSO | A user who has signed in to any product of this platform does not need to enter a password again when entering yours. |

Hard rules:
- **`product_id` / `env` / `user_id` may only come from credentials and tokens issued by the platform.** Do not trust a `user_id` that your frontend sends to your backend; the backend takes it from the token with `verifyToken` (section 5).
- A token of one product cannot be used for another product (you get 401); do not try.
- The platform does not host your business database; it only provides accounts, file storage, logs and event analytics.

## 2. What a human must prepare in the console

The console: `https://console.example.com` (only platform team members can sign in). Ask the human owner to do the following and give you the results:

| Item | Where in the console | Value for the AI |
|---|---|---|
| Product ID | Products → New product (starts with a lowercase letter, 3–32 lowercase letters/digits/underscores, **cannot be changed after creation**) | e.g. `my_game` |
| Redirect URI | Product → Settings → Redirect URIs (one per line, valid for all environments) | e.g. `http://localhost:5173/`, `https://game.example.com/` |
| Allowed origins | Same page → Allowed origins (the page's origin, without a path) | e.g. `http://localhost:5173` |
| Publishable key | Product → Environments & keys → the row of the environment | `pk_dev_…` (development), `pk_prod_…` (production) |
| Storage buckets (if you use file storage) | Product → Buckets → New (one per environment) | e.g. `avatars`, `saves` |
| Service key (if you have a backend) | Product → Environments & keys → Create service key, tick the scopes you need (`logs:write`, `events:write`, `storage:read`, `storage:write`, `users:read`) | `sk_dev_…`, **shown only once**; put it straight into the backend's secret store / environment variables |
| Visibility | Product → Settings → Visibility | Guest mode needs "public" |

Platform addresses:

```ts
export const PLATFORM = {
  issuer: 'https://id.example.com',    // identity domain (sign-in pages, OIDC)
  endpoint: 'https://api.example.com', // platform API
};
```

> The redirect URI must match **character for character** (including a trailing `/`). Register both the local development address and the production domain. Changes take effect immediately.

## 3. Install the SDK

Install from npm:

```sh
npm i @z-cloudbase/web       # frontend
npm i @z-cloudbase/server    # backend (Node 20+ / Cloudflare Workers / any runtime with fetch)
```

If your self-hosted platform changed the SDK, or npm is not reachable, use the tgz packages instead: the platform team runs `pnpm sdk:pack` in the z-cloudbase repository root (output `dist-sdk/z-cloudbase-web-<version>.tgz`, `dist-sdk/z-cloudbase-server-<version>.tgz`); the product repository commits them under `vendor/` and runs `npm i ./vendor/z-cloudbase-web-<version>.tgz`.

- Both packages are ESM and ship TypeScript types; `@z-cloudbase/web` depends only on `jose` and is about 37 KB minified (14 KB gzip, including jose; modules you do not use can be imported separately via subpaths such as `@z-cloudbase/web/analytics`).
- Upgrade: `npm i @z-cloudbase/web@latest @z-cloudbase/server@latest` (with tgz files, replace them in `vendor/` and run `npm i` again).
- Clients that do not use JS (native apps, backends in other languages): call the HTTP API directly (section 6).

## 4. Frontend: `@z-cloudbase/web`

### 4.1 Initialization (create it once per page)

```ts
import { createClient } from '@z-cloudbase/web';

export const platform = createClient({
  issuer: 'https://id.example.com',
  endpoint: 'https://api.example.com',
  productId: 'my_game',
  env: 'dev',                                  // must match the environment of publishableKey, otherwise the constructor throws
  publishableKey: 'pk_dev_xxxxxxxx',
  redirectUri: `${location.origin}/`,          // must be a redirect URI registered in the console
  storage: localStorage,                       // see below
  autocapture: { pageViews: true, sessions: true }, // optional, see 4.6
});
```

`storage` (where the refresh token is kept):
- Omitted: in memory only, **a page reload signs the user out** (but the identity domain has an SSO session, so calling `signInWithRedirect()` again signs them back in without interaction).
- `sessionStorage`: invalid once the tab is closed; suits admin-style, security-sensitive apps.
- `localStorage`: stays signed in for a long time, suits games; the cost is that the refresh token can be stolen if the page has an XSS flaw. The access token is always kept in memory only.

### 4.2 Sign-in (regular apps)

```ts
// when the page starts
async function boot() {
  if (new URLSearchParams(location.search).has('code')) {
    await platform.auth.handleRedirectCallback(); // verifies state / nonce / id_token, exchanges for tokens
    history.replaceState(null, '', '/');         // remove the code from the address bar
  }
  const me = await platform.auth.getUser();       // null when signed out; a saved refresh token is renewed automatically
  render(me);
}

// the user clicks "Sign in"
loginButton.onclick = () => platform.auth.signInWithRedirect(); // goes to the identity domain's sign-in page, then back to redirectUri

// the user clicks "Sign out"
logoutButton.onclick = async () => { await platform.auth.signOut(); render(null); };

// sign-in state changes: fires on a successful sign-in on this page, restore from a saved refresh token, sign-out, and a failed renewal (not synchronized across tabs)
platform.auth.onAuthStateChange((user) => render(user ? 'signed-in' : null));
```

- The sign-in page is provided by the platform (email + password, sign-up, password recovery; when enabled by the deployment also Passkey, email sign-in links, Google / Apple). Your product **must not** build its own password form or collect passwords. Every method returns to the same `redirectUri` after sign-in, so product code does not need to tell them apart.
- The sign-in page is shown in Chinese or English according to the browser language, and the user can switch on the page. To force a language, send the user to `https://id.example.com/login?lang=zh` (or `en`); the choice is remembered.
- The deployment's sign-up mode (PRD §21.2) decides whether new users can register: `open` lets anyone register; `invite` lets only people who received a platform invitation register; `closed` no longer creates new accounts. In the latter two modes, a user without an account stays on the sign-in page, and the product should show "contact the platform administrator for an invitation".
- The callback page can simply be the home page; what matters is that it handles `?code=`.

### 4.3 Guest mode (games and other "play first, register later" products)

```ts
// without a sign-in state, enter directly as a guest: no sign-in page is shown
if (!(await platform.auth.getUser())) {
  await platform.auth.signInWithRedirect({ guest: true });
}
```

- If the user has already signed in to another product of the platform, they enter with their real account (they are not downgraded to a guest).
- A guest also has a real `user_id`, and `getUser()` returns `anonymous: true`. Store guest data by `user_id` as well.
- **Upgrade to a real account**: send the user to `https://id.example.com/link` (new tab or redirect). After they set an email and password, the `user_id` and all product data **stay unchanged**. When they come back, call `platform.auth.signInWithRedirect()` once (SSO, no input needed) to refresh the token; `getUser().anonymous` is then `false`.
- Guests inactive for 30 days are reclaimed by the platform; prompt users in your game to link an email in time.
- The product's visibility must be "public", otherwise guests cannot join automatically.
- Only deployments whose sign-up mode is `open` allow new guests; under `invite` / `closed`, `/guest` returns 403 (`details.reason = "signup_closed"`), and users who already have a session are not affected. In that case the game should fall back to regular sign-in (`signInWithRedirect()`).

### 4.4 The current user

```ts
const me = await platform.auth.getUser();
// {
//   user_id: 'usr_01a1…',          // global ID: the foreign key of your business data
//   anonymous: false,
//   product_id: 'my_game', env: 'dev',
//   membership: { status: 'active', joined_at: '2026-10-09T…Z' }
// }
const token = await platform.auth.getAccessToken(); // put it in Authorization: Bearer when calling your own backend
```

The platform **does not provide** a user's email, nickname or avatar; those are product business data that your product stores itself (keyed by `user_id`).

### 4.5 File storage (a user's private files)

```ts
const obj = await platform.storage.createUpload({ bucket: 'saves', file }); // file: File or Blob
// obj: { id, bucket, filename, content_type, size, status: 'available', … }
const { url } = await platform.storage.getDownloadUrl(obj.id, { ttlSeconds: 300 }); // default 5 minutes, at most 1 hour
const page = await platform.storage.list({ bucket: 'saves', limit: 50 });         // { objects, next_cursor }
await platform.storage.delete(obj.id);
```

- The user must be signed in; a file is visible only to its uploader, in this product and this environment.
- Bytes go straight to object storage without passing through your server; the download URL is a short-lived signed link: do not store it in a database, fetch it when needed.
- Limits are set in the console's "Environment settings": maximum file size (default 50 MB), total quota (default 5 GB), daily upload quota (default 1 GB), MIME / extension allowlist. Images are checked against their real file header.
- Related error codes: `quota_exceeded`, `payload_too_large`, `unsupported_type`, `not_found`.

### 4.6 Event analytics

```ts
platform.analytics.track('level_complete', { level: 3, score: 1200, stars: 2 });
platform.analytics.identify();  // call once after the user signs in: later events are tied to that user (otherwise counted as an anonymous visitor)
platform.analytics.reset();     // call on sign-out
```

- Event names: start with a lowercase letter, `[a-z0-9_]`, at most 64 characters (e.g. `purchase_success`); invalid events are **silently dropped**.
- Properties: at most 50 keys, ≤ 8 KB serialized; values may only be strings (≤1024), numbers, booleans or null. Do not put email addresses, phone numbers, tokens or other personal or sensitive data in them.
- The SDK sends in batches automatically (every 5 seconds by default, also when the page is hidden / closed) and deduplicates (the same `event_id` counts once within 24 hours).
- Events whose schema is not registered in the console: dev/staging accept them normally; prod handles them according to the environment's "unknown events" policy.
- Reports are in the console's "Analytics" (overview, funnels, retention, breakdowns, event details, export), with a delay of about 1–2 minutes.
- Browser / OS / device type and country are inferred by the platform from the request; **do not** put them in properties yourself (they will not be treated as those dimensions).

**Autocapture** (`createClient({ autocapture: {...} })`, all off by default):

| Option | Event | Description |
|---|---|---|
| `pageViews: true` | `page_view` | Properties `path`, `referrer`, `title`; since 0.2.0 `path` / `referrer` do not include the query string (hash routes starting with `#/` are kept) |
| `sessions: true` | `session_start` | A new `session_id` after 30 minutes without events |
| `errors: true` | `js_error` | Uncaught exceptions and unhandled Promise rejections: `message`, `type`, `stack` (first 1000 characters), `source`, `line`, `col`, `path`; tokens are masked and URL query strings removed; the same error is reported only once per page, at most 10 per page |
| `webVitals: true` | `web_vital` | `name` (LCP / INP / CLS / FCP / TTFB), `value` (milliseconds; CLS has no unit), `rating`; each metric is reported once when the page is hidden. INP is the slowest interaction on the page (an approximation) |
| `clicks: true` or `'attribute'` | `element_click` | Links, buttons and elements with `data-zcb-track="name"`: `tag`, `selector`, `text` (≤ 64 characters), `href`, `label`. `'attribute'` captures only elements with the attribute; elements whose ancestor has `data-zcb-no-track` are not captured; **input values are never read** |

**User consent**:

```ts
platform.analytics.optOut();      // the user declines: pending events and the anonymous ID are cleared; afterwards neither track nor autocapture sends anything; the choice is remembered
platform.analytics.optIn();       // the user agrees
platform.analytics.hasOptedOut(); // current state
// To "collect only after consent": createClient({ ..., analytics: { consent: 'denied' } }), then call optIn() once the user agrees
```

**User properties** (visible only in this product and environment; other products cannot see them):

```ts
await platform.analytics.setUserProperties({ plan: 'pro', level: 12 }); // requires sign-in; a null value deletes the key
platform.analytics.identify({ plan: 'pro' });                            // after sign-in, ties events to the user and sets properties at the same time (does not throw)
```

- Keys `[A-Za-z0-9_]`, ≤ 64 characters; values are scalars, strings ≤ 256 characters; at most 20 keys and 2 KB per user. Exceeding this returns `payload_too_large` and existing properties are unchanged.
- Guests (anonymous visitors) have no user properties; put them in event properties if needed.
- Used by the "user property" filter of the console's funnels / retention, and for viewing by user in event details.

### 4.7 Frontend error reporting

```ts
window.addEventListener('error', (e) => platform.logs.captureError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => platform.logs.captureError(e.reason));
```

`captureError` never throws; it strips URL query parameters, truncates overlong content and masks token-like strings. Search them in the console's "Logs" by environment / level / time.

### 4.8 Error handling

Every failure throws `PlatformError`:

```ts
import { PlatformError } from '@z-cloudbase/web';
try { … } catch (e) {
  if (e instanceof PlatformError) {
    e.code;       // see the table below
    e.status;     // HTTP status code (undefined for network errors)
    e.requestId;  // include it when reporting problems
    e.retryable;  // true means you may retry later (the SDK already retries retryable requests automatically)
  }
}
```

| code | Meaning / what to do |
|---|---|
| `unauthenticated` / `invalid_token` / `token_expired` | Not signed in or the sign-in expired → call `signInWithRedirect()` |
| `membership_required` | Restricted product and the user is not a member → show "no permission" |
| `product_disabled` | The product was disabled by the platform → show a maintenance notice |
| `impersonation_restricted` | Not allowed during a support session (impersonation), e.g. leaving the product or deleting files → show "not available during a support session" |
| `forbidden` / `forbidden_product` | No access to this resource |
| `validation_failed` / `invalid_request` | Invalid parameters, fix the code |
| `not_found` | The resource does not exist (or does not belong to the current user; the platform does not distinguish) |
| `quota_exceeded` / `payload_too_large` / `unsupported_type` | Storage limits, see 4.5 |
| `rate_limited` | Too frequent, retry later according to `Retry-After` |
| `unavailable` / `internal` / `timeout` / `network_error` | A temporary platform or network failure, retryable |
| `state_mismatch` / `nonce_mismatch` | The sign-in callback was tampered with or processed twice → sign in again |

## 5. Backend: `@z-cloudbase/server`

```ts
import { createServerClient } from '@z-cloudbase/server';

export const platform = createServerClient({
  issuer: 'https://id.example.com',
  endpoint: 'https://api.example.com',
  serviceKey: process.env.PLATFORM_SERVICE_KEY!, // sk_dev_…, server side only
});
```

### 5.1 Verify the user sent by the frontend (the most common case)

```ts
// frontend: fetch('/api/save', { headers: { Authorization: `Bearer ${await platform.auth.getAccessToken()}` } })
const token = req.headers.authorization?.replace(/^Bearer /, '');
const claims = await platform.auth.verifyToken(token!, { productId: 'my_game', env: 'dev' });
claims.sub;   // user_id — use it to read and write your business data
claims.anon;  // whether the user is a guest
```

Verification is local (the JWKS is fetched only the first time / on key rotation) and does not call the platform API. A token of another product or another environment always fails verification.

**Impersonation (platform support staff troubleshooting as a user)**: a platform owner can start a time-limited (at most 60 minutes), fully audited impersonation in the console. Tokens issued during it carry the RFC 8693 `act` claim: `claims.act = { sub: '<the owner's user_id>' }` (the user object returned by the frontend `onAuthStateChange` / `handleRedirectCallback` accordingly has an `actor` field). `claims.sub` is still the impersonated user. The product decides how to treat it:

```ts
if (claims.act) {
  // e.g. forbid sensitive operations such as payments, withdrawals, data deletion; or reject everything
  return res.status(403).json({ error: 'not allowed during a support session' });
}
```

The platform itself guarantees that an impersonation session cannot enter the console, cannot change the user's password, email, sign-in methods or two-factor authentication, and cannot export or delete the account; it can only enter product environments the user signed in to themselves (it never joins a new product for them or triggers `user.joined`); with an `act` token, leaving the product (`DELETE /v1/me/membership`) and deleting storage objects return 403 `impersonation_restricted`, while reads, uploads and event tracking work as usual. After a user is banned by the platform, already issued access tokens get 403 `user_banned` when calling the platform API, refresh fails (`invalid_grant`), and signing in again is rejected; your backend, verifying locally with `verifyToken`, will still accept the token for up to its remaining 15 minutes — subscribe to the `user.banned` webhook below when you need it to take effect immediately.

### 5.4 Webhooks (the platform pushes user events)

In the console, "Product → Webhooks", add an endpoint for an environment: the URL must be `https://` (only the `dev` environment allows `http://localhost`) and must not point to an internal / loopback address; tick the events to subscribe to; after saving, the signing secret `whsec_…` is shown only once, so put it in a server-side environment variable.

| Event | When | `data` |
|---|---|---|
| `user.joined` | The user completes sign-in authorization in this product environment for the first time | `{ user_id, anonymous, first_seen_at }` |
| `user.upgraded` | A guest linked their first sign-in method (`user_id` unchanged) | `{ user_id, provider }` |
| `user.deleted` | Deletion completed: `scope: "account"` the user deleted the platform account; `"product"` the user left this product and the platform data has been cleaned up | `{ user_id, scope }` |
| `user.banned` / `user.unbanned` | The platform bans / unbans (including automatic unban on expiry, `reason: "expired"`) | `{ user_id, expires_at }` / `{ user_id, reason }` |

The request body is always `{ id, type, timestamp, product_id, env, data }` and contains no personal information such as email addresses. When you receive `user.deleted`, delete that user's business data on your side.

```ts
import { verifyWebhook } from '@z-cloudbase/server';

// verify with the raw request body, and parse only after verification passes
app.post('/webhooks/platform', express.text({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook({ secret: process.env.PLATFORM_WEBHOOK_SECRET!, headers: req.headers, body: req.body });
  } catch {
    return res.sendStatus(401);
  }
  if (await alreadyProcessed(event.id)) return res.sendStatus(204); // at-least-once delivery: deduplicate by event.id
  if (event.type === 'user.deleted') await deleteBusinessData(event.data.user_id);
  res.sendStatus(204);
});
```

- Signatures follow [Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,` + HMAC-SHA256); any language can verify per that specification. A timestamp more than 5 minutes away from the current time is treated as a replay.
- Only 2xx counts as success; 10-second timeout, redirects are not followed. After a failure, delivery is retried after 15 minutes, 30 minutes, 1, 2, 4, 8 and 12 hours, 8 attempts in total (about 28 hours) before giving up. Return 2xx quickly and move slow processing to a queue.
- After rotating the secret, the old secret keeps signing in parallel for 24 hours (the signature header carries two signatures); update the environment variable within that window.
- The console can "send a test" (the `webhook.test` event) and shows the latest 100 deliveries (status code, duration, error; the first 256 characters of a 2xx response, only the status line for failures).

### 5.2 Server-side logs and events

```ts
platform.logs.info('order paid', { order_id: 'o_123', amount: 30 }, { request_id: reqId });
platform.logs.error('payment webhook failed', { provider: 'x' });
platform.analytics.track('purchase', { amount: 30 }, { eventId: orderId, userId: claims.sub }); // a business ID (UUID) as eventId prevents double counting
await platform.analytics.setUserProperties(claims.sub, { plan: 'pro' });
await platform.flush(); // call before the request ends; in Cloudflare Workers use ctx.waitUntil(platform.flush())
```

- `userId` is optional: only users with a valid membership in this product are accepted (usually the `sub` from `verifyToken`); otherwise that event is rejected (`membership_required`). The platform stores only its pseudonym within this product, not the raw ID. `trackServerEvent` is the old name of `track` and still works.
- Server events have no browser / device / country dimensions (a server's request does not represent the user's device). When you need the frontend's anonymous ID, pass it as `anonymousId`.

Fields such as `password`, `secret`, `token`, `authorization`, `cookie`, `api_key` in log attributes are redacted automatically; still do not log personal information on purpose.

### 5.3 Server-side files

```ts
const obj = await platform.storage.createUpload({ bucket: 'reports', filename: 'r.pdf', contentType: 'application/pdf', body: bytes });
const { url } = await platform.storage.getDownloadUrl(obj.id);
```

The service key needs `storage:write` / `storage:read`.

## 6. Without the SDK: the HTTP API

All requests go to `https://api.example.com/v1/…`. The error body is always `{ "error": { "code", "message", "request_id", "retryable", "details?" } }`, and responses carry the `x-request-id` header.

| Header | Purpose |
|---|---|
| `X-Platform-Key: pk_…` | Frontend / client requests (identifies the product and environment) |
| `X-Platform-Key: sk_…` | Server requests: always handled as the "service" identity, even with a user token attached, which does not represent that user |
| `Authorization: Bearer <access token>` | Acts on behalf of a user (together with `pk_`) |

| Method Path | Credential | Description |
|---|---|---|
| `GET /v1/me` | pk + user token | The current user's information in this product |
| `POST /v1/storage/uploads` | pk + user token, or sk | Request an upload: `{ bucket, filename, content_type, size }` → `{ object_id, method: 'PUT', url, headers, expires_at }`; PUT the bytes to `url` with those headers |
| `POST /v1/storage/uploads/{id}/complete` | same | Confirm after the PUT finished |
| `POST /v1/storage/downloads` | same | `{ object_id, ttl_seconds? }` → a signed download address |
| `GET /v1/storage/objects?bucket=&cursor=&limit=` | same | List files |
| `DELETE /v1/storage/objects/{id}` | same | Delete |
| `POST /v1/events/batch` | pk (optionally with a user token) or sk (`events:write`) | `{ events: [{ event_id(uuid), event_name, occurred_at(ISO), properties?, anonymous_id?, session_id?, user_id? }] }`, ≤100 events / 256 KB; `user_id` is allowed for sk only and must be a member of this product (otherwise that event gets `membership_required`); events from a pk carrying `user_id` are rejected (`user_id_not_allowed`) |
| `POST /v1/events/user-properties` | pk + user token, or sk (`events:write`) | `{ properties: {k: scalar or null}, user_id? }` (`user_id` is for sk only and then required) → `{ properties }` (all properties after merging) |
| `POST /v1/logs/batch` | pk or sk (`logs:write`) | `{ logs: [{ level, timestamp, message, attributes?, request_id? }] }`, ≤100 entries / 512 KB |

User tokens are obtained with the standard OIDC authorization code + PKCE (S256): the authorization and token endpoints are listed at `https://id.example.com/.well-known/openid-configuration`; `client_id` = `{product_id}.{env}`; you must send `resource=urn:platform:{product_id}.{env}`; scope `openid offline_access`. The access token lives 15 minutes; the refresh token 30 days and is rotated on every use (the old one is invalid immediately, and a replay revokes the whole family).

## 7. Platform limits (defaults)

| Item | Limit |
|---|---|
| Sign-in / sign-up | 10 per minute per IP, 5 per minute per account; when the deployment has Turnstile configured, a human check is required after 3 failures within 15 minutes for the same account or IP |
| Ingestion | 600 batches per minute per key |
| access token / refresh token | 15 minutes / 30 days (rotating) |
| Upload signed URL | valid for 10 minutes |
| Event time | `occurred_at` no earlier than 7 days ago and no later than 5 minutes ahead |
| User properties | ≤ 20 keys and ≤ 2 KB per user per product environment |
| Analytics data retention | 90 days by default (deployment configuration); raw event archive 90 days by default, the console can export NDJSON / CSV (≤ 31 days per export) |

## 8. Acceptance checklist (confirm each item after integration and report)

- [ ] First visit → sign in (or enter as a guest) → back in the product; `getUser()` returns this product's `product_id` and `env`.
- [ ] After a page reload the user is still signed in (as expected for the `storage` you chose).
- [ ] In a browser already signed in to another product of this platform, entering this product needs no password, and the `user_id` is the same.
- [ ] After signing out `getUser()` is `null`.
- [ ] (With a backend) the `sub` the backend gets from `verifyToken` equals the frontend's `getUser().user_id`; a forged token or a token of another product is rejected.
- [ ] (Analytics) the console's "Analytics" shows your events within 1–2 minutes.
- [ ] (Error reporting) throw an error on purpose; the console's "Logs" can find it.
- [ ] (Storage) upload → list → downloaded content is identical → after deletion the download address stops working.
- [ ] Searching the repository and the frontend build output finds no `sk_`.
- [ ] (Webhooks) after "send a test" in the console, your receiver verifies it with `verifyWebhook`; after modifying the request body, verification fails.
- [ ] (Impersonation) decide and implement how your backend handles tokens carrying the `act` claim (at minimum, forbid sensitive operations).

## 9. Current limitations (tell the human owner)

- The available sign-in methods depend on the deployment configuration: guests are available only when the sign-up mode is `open`; email + password sign-up by default needs the operator to configure a mail service (verification emails; Resend / SMTP / Cloudflare Email Service); email sign-in links appear only when mail is configured; Passkey is enabled by default; Google / Apple need credentials configured by the operator. Real email delivery, real Passkey devices and real Google / Apple have not been verified remotely (tested locally with stand-ins).
- "BFF sign-in" for server-rendered apps (`platform.bff(...)`) needs a confidential client, which the console cannot create yet, so it is not usable; use frontend sign-in + backend `verifyToken`.
- Native apps (system browser + custom-scheme callback) have not been verified.
- The SDK has a 15-second default timeout and retries retryable errors automatically.
- Funnels / retention are computed per "user" (the user when signed in, the device's anonymous ID when not); before and after sign-in they are not merged into one person automatically. In production, the "breakdown" reports are based on Analytics Engine, and distinct-user counts are approximate under high traffic.
