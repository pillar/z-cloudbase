# Product Integration Guide (for the AI developer of a product)

> Translation of [integration-guide.md](integration-guide.md) (Chinese, the maintained original). If the two differ, the Chinese version wins.
>
> Version: SDK 0.1.0 · updated 2026-11-03
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

The SDK is not published to npm yet; use the tgz packages provided by the platform team:

```sh
# The platform team runs this in the z-cloudbase repository root; the output is in dist-sdk/
pnpm sdk:pack     # → dist-sdk/z-cloudbase-web-0.1.0.tgz, dist-sdk/z-cloudbase-server-0.1.0.tgz

# In your product repository: put the tgz files in vendor/ and commit them (so CI installs are reproducible)
mkdir -p vendor && cp <platform repo>/dist-sdk/z-cloudbase-*.tgz vendor/
npm i ./vendor/z-cloudbase-web-0.1.0.tgz          # frontend
npm i ./vendor/z-cloudbase-server-0.1.0.tgz       # backend (Node 20+ / Cloudflare Workers / any runtime with fetch)
```

- Both packages are ESM and ship TypeScript types; `@z-cloudbase/web` depends only on `jose` and is about 34 KB minified (13 KB gzip).
- Upgrade: replace the tgz files in `vendor/` and run `npm i` again.
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
  autocapture: { pageViews: true, sessions: true }, // optional: automatic page_view / session_start
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

- The sign-in page is provided by the platform (email + password, sign-up, password recovery). Your product **must not** build its own password form or collect passwords.
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
- Reports are in the console's "Analytics" (daily active users, event volume, top events), with a delay of about 1–2 minutes.

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

### 5.2 Server-side logs and events

```ts
platform.logs.info('order paid', { order_id: 'o_123', amount: 30 }, { request_id: reqId });
platform.logs.error('payment webhook failed', { provider: 'x' });
platform.analytics.trackServerEvent('purchase', { amount: 30 }, { eventId: orderId }); // a business ID as eventId prevents double counting
await platform.flush(); // call before the request ends; in Cloudflare Workers use ctx.waitUntil(platform.flush())
```

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
| `POST /v1/events/batch` | pk (optionally with a user token) or sk (`events:write`) | `{ events: [{ event_id(uuid), event_name, occurred_at(ISO), properties?, anonymous_id?, session_id? }] }`, ≤100 events / 256 KB |
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

## 9. Current limitations (tell the human owner)

- The available sign-in methods depend on the deployment configuration: guests are always available; email + password sign-up needs the operator to configure a mail service (verification emails); Google / Apple need credentials configured by the operator and have not been verified against the real providers.
- "BFF sign-in" for server-rendered apps (`platform.bff(...)`) needs a confidential client, which the console cannot create yet, so it is not usable; use frontend sign-in + backend `verifyToken`.
- Native apps (system browser + custom-scheme callback) have not been verified.
- The SDK has a 15-second default timeout and retries retryable errors automatically.
