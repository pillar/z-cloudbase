// PRD §15 item 13 (+ §19.8): data export and account deletion are requested on the identity domain
// (session + recent sign-in), tracked, and carried out by the consumer cron with verifiable results;
// leaving one product cleans up that product only. Product APIs cannot start either. Exports are
// downloaded through one-time, 15-minute links of their owner (PRD §19.11).
import { beforeAll, describe, expect, it } from 'vitest';
import { d1, r2Keys, triggerCron } from '../local-stack/stack.ts';
import {
  PASSWORD, admin, api, createBucket, createProduct, createWebApp, newUser, ownerToken as ownerConsoleToken, signIn, stack, uniqueProductId,
} from '../src/world.ts';
import { Browser } from '../src/browser.ts';

let ownerToken: string;
let a: Awaited<ReturnType<typeof createProduct>>;
let b: Awaited<ReturnType<typeof createProduct>>;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  a = await createProduct(ownerToken, uniqueProductId('da'));
  b = await createProduct(ownerToken, uniqueProductId('db'));
  await createBucket(ownerToken, a.prod, 'files');
  await createBucket(ownerToken, b.prod, 'files');
});

const issuer = () => stack().issuer;
const QUARTER_HOUR = '*/15 * * * *';
type Req = { id: string; kind: string; scope: string; status: string; due_at: string; completed_at: string | null };

/** A user with one file in A and one in B. */
async function userWithFiles(tag: string) {
  const u = await newUser(tag);
  const files: Record<string, string> = {};
  for (const p of [a, b]) {
    const app = createWebApp(u.browser, p.prod);
    await app.signIn();
    files[p.productId] = (await app.sdk.storage.createUpload({ bucket: 'files', file: new Blob([`${tag} in ${p.productId}`], { type: 'text/plain' }), filename: 'f.txt' })).id;
  }
  return { ...u, files, appA: createWebApp(u.browser, a.prod) };
}

async function requests(browser: Browser): Promise<Req[]> {
  const res = await browser.request(`${issuer()}/account/requests`, { headers: { accept: 'application/json' } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { requests: Req[] }).requests;
}

const objectKeys = async (productId: string) => r2Keys(stack(), 'cloudbase-storage', `${productId}/prod/files/`);

describe('§15-13 account-level requests start on the identity domain only', () => {
  it('product APIs offer no account deletion or export, whatever the token', async () => {
    const u = await userWithFiles('noapi');
    await u.appA.signIn();
    const token = (await u.appA.sdk.auth.getAccessToken())!;
    for (const [path, method] of [['/v1/me/deletion', 'POST'], ['/v1/me/export', 'POST'], ['/v1/me/deletion', 'DELETE']] as const) {
      expect((await api(path, { key: a.prod.publishableKey, token, method })).status).toBe(404);
    }
  });
});

describe('§15-13 data export', () => {
  it('is requested on the identity domain, built by the cron and downloaded once per one-time link, by its owner only', async () => {
    const u = await userWithFiles('export');
    const res = await u.browser.request(`${issuer()}/account/export`, { method: 'POST', headers: { accept: 'application/json' } });
    expect(res.status).toBe(202);
    const req = (await res.json()) as Req;
    expect(req).toMatchObject({ kind: 'export', scope: 'account', status: 'pending' });

    await triggerCron(stack(), QUARTER_HOUR);
    const done = (await requests(u.browser)).find((r) => r.id === req.id)!;
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();

    // One-time link (PRD §19.11): created with a recent sign-in, downloads exactly once.
    const created = await u.browser.request(`${issuer()}/account/exports/${req.id}/link`, { method: 'POST', headers: { accept: 'application/json' } });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { url: string; expires_at: string };
    expect(Date.parse(link.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const dl = await u.browser.request(link.url);
    expect(dl.status).toBe(200);
    expect((await u.browser.request(link.url)).status).toBe(404);
    // The former direct download route no longer exists.
    expect((await u.browser.request(`${issuer()}/account/exports/${req.id}`)).status).toBe(404);
    const doc = (await dl.json()) as {
      scope: string; identity: { user_id: string; email: string; providers: string[] };
      memberships: Array<{ product_id: string }>; storage_objects: Array<{ id: string }>;
    };
    expect(doc.scope).toBe('account');
    expect(doc.identity).toMatchObject({ user_id: u.userId, email: u.email, providers: ['credential'] });
    expect(doc.memberships.map((m) => m.product_id).sort()).toEqual([a.productId, b.productId].sort());
    expect(doc.storage_objects.map((o) => o.id).sort()).toEqual(Object.values(u.files).sort());
    expect(JSON.stringify(doc)).not.toMatch(/password|hash|scrypt/i);
    // The export object exists in the private archive; nothing was deleted.
    expect(await r2Keys(stack(), 'cloudbase-archive', `exports/${u.userId}/`)).toEqual([`exports/${u.userId}/${req.id}.json`]);
    expect((await objectKeys(a.productId)).some((k) => k.endsWith(u.files[a.productId]!))).toBe(true);

    // A link is not usable by anyone else (and stays usable by its owner), nor through the api origin;
    // another user cannot create one for this export.
    const other = await newUser('export-other');
    const second = (await (await u.browser.request(`${issuer()}/account/exports/${req.id}/link`, { method: 'POST', headers: { accept: 'application/json' } })).json()) as { url: string };
    expect((await other.browser.request(second.url)).status).toBe(404);
    const path = new URL(second.url).pathname;
    expect((await fetch(`${stack().apiOrigin}${path}`)).status).toBe(404);
    expect((await other.browser.request(`${issuer()}/account/exports/${req.id}/link`, { method: 'POST', headers: { accept: 'application/json' } })).status).toBe(404);
    // The account page's Download button posts a form and lands on a fresh link.
    expect(await (await u.browser.request(`${issuer()}/account`)).text()).toContain(`action="/account/exports/${req.id}/link"`);
    const viaForm = await u.browser.request(`${issuer()}/account/exports/${req.id}/link`, { form: {} });
    expect(viaForm.status).toBe(303);
    expect((await u.browser.request(new URL(viaForm.headers.get('location')!, issuer()).toString())).status).toBe(200);
    expect((await u.browser.request(second.url)).status).toBe(200);

    // Both steps are in the audit trail.
    const audit = await admin<{ entries: Array<{ action: string; target_id: string }> }>(ownerToken, 'GET', '/audit?limit=500');
    const actions = audit.body.entries.filter((e) => e.target_id === req.id).map((e) => e.action);
    expect(actions.filter((x) => x === 'account.export.link_create')).toHaveLength(3);
    expect(actions.filter((x) => x === 'account.export.download')).toHaveLength(3);
  });
});

describe('§15-13 account deletion', () => {
  it('needs a recent sign-in, honours the cooldown, can be cancelled, and is executed by the cron once due', async () => {
    const u = await userWithFiles('delete');

    // A session older than 5 minutes is refused (age the session row; only way to fast-forward a live stack).
    const [current] = await d1<{ createdAt: string | number }>(stack(), 'platform', 'SELECT createdAt FROM session WHERE userId = ? LIMIT 1', [u.userId]);
    const old = new Date(Date.now() - 10 * 60_000);
    await d1(stack(), 'platform', 'UPDATE session SET createdAt = ? WHERE userId = ?', [typeof current!.createdAt === 'number' ? old.getTime() : old.toISOString(), u.userId]);
    const stale = await u.browser.request(`${issuer()}/account/deletion`, { method: 'POST', headers: { accept: 'application/json' } });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('reauth_required');
    await signIn(u.browser, u.email, PASSWORD); // re-authenticate

    // Cross-site submissions are refused even with the session cookie.
    const csrf = await u.browser.request(`${issuer()}/account/deletion`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(csrf.status).toBe(403);

    // Request, cancel, request again.
    const first = (await (await u.browser.request(`${issuer()}/account/deletion`, { method: 'POST', headers: { accept: 'application/json' } })).json()) as Req;
    expect(Date.parse(first.due_at) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect((await u.browser.request(`${issuer()}/account/deletion`, { method: 'DELETE' })).status).toBe(204);
    const second = (await (await u.browser.request(`${issuer()}/account/deletion`, { method: 'POST', headers: { accept: 'application/json' } })).json()) as Req;
    expect(second.id).not.toBe(first.id);

    // During the cooldown the cron leaves everything in place.
    await triggerCron(stack(), QUARTER_HOUR);
    expect((await requests(u.browser)).find((r) => r.id === second.id)!.status).toBe('pending');
    expect((await objectKeys(a.productId)).some((k) => k.endsWith(u.files[a.productId]!))).toBe(true);

    // Cooldown elapsed (fast-forward due_at), then the cron runs the deletion.
    await d1(stack(), 'platform', 'UPDATE deletion_requests SET due_at = ? WHERE id = ?', [Date.now() - 1000, second.id]);
    await triggerCron(stack(), QUARTER_HOUR);

    const row = await d1<{ status: string }>(stack(), 'platform', 'SELECT status FROM deletion_requests WHERE id = ?', [second.id]);
    expect(row[0]!.status).toBe('completed');
    // Storage objects of every product are gone (R2 and rows).
    for (const [productId, objectId] of Object.entries(u.files)) {
      expect((await objectKeys(productId)).some((k) => k.endsWith(objectId))).toBe(false);
    }
    expect(await d1(stack(), 'platform', 'SELECT id FROM storage_objects WHERE owner_user_id = ?', [u.userId])).toEqual([]);
    // Identity reduced to a tombstone: no memberships, no credentials, cannot sign in, sessions gone.
    const looked = await admin<{ user: { email: string; deleted_at: unknown }; memberships: unknown[] }>(ownerToken, 'GET', `/users?user_id=${u.userId}`);
    expect(looked.body.user.deleted_at).toBeTruthy();
    expect(looked.body.user.email).not.toBe(u.email);
    expect(looked.body.memberships).toEqual([]);
    await expect(signIn(new Browser(issuer()), u.email)).rejects.toThrow(/401/);
    expect(await (await u.browser.request(`${issuer()}/api/auth/get-session`)).json()).toBeNull();
    // Traceable: system audit rows for the pipeline and the identity step.
    const audit = await admin<{ entries: Array<{ action: string; target_id: string }> }>(ownerToken, 'GET', '/audit?limit=500');
    const actions = audit.body.entries.filter((e) => [u.userId, first.id, second.id].includes(e.target_id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['account.deletion.request', 'account.deletion.cancel', 'delete.completed', 'auth.identity_deleted']));
  });
});

describe('§19.8 leaving one product', () => {
  it("revokes the membership, and the cron deletes that product's files only; other products neither change nor see the request", async () => {
    const u = await userWithFiles('leave');
    await u.appA.signIn();
    const token = (await u.appA.sdk.auth.getAccessToken())!;
    expect((await api('/v1/me/membership', { key: a.prod.publishableKey, token, method: 'DELETE' })).status).toBe(204);
    expect((await api('/v1/me', { key: a.prod.publishableKey, token })).status).toBe(403);

    await triggerCron(stack(), QUARTER_HOUR);
    expect((await objectKeys(a.productId)).some((k) => k.endsWith(u.files[a.productId]!))).toBe(false);
    expect((await objectKeys(b.productId)).some((k) => k.endsWith(u.files[b.productId]!))).toBe(true);
    const appB = createWebApp(u.browser, b.prod);
    await appB.signIn();
    expect(await appB.sdk.auth.getUser()).toMatchObject({ membership: { status: 'active' } });
    const leaveRows = await d1<{ status: string; product_id: string }>(stack(), 'platform',
      `SELECT status, product_id FROM deletion_requests WHERE user_id = ? AND scope = 'product'`, [u.userId]);
    expect(leaveRows).toEqual([{ status: 'completed', product_id: a.productId }]);
    // Not visible from B's API (product-scoped request of another product).
    const fromB = await api('/v1/me/requests', { key: b.prod.publishableKey, token: (await appB.sdk.auth.getAccessToken())! });
    expect(((await fromB.json()) as { requests: unknown[] }).requests).toEqual([]);
  });
});
