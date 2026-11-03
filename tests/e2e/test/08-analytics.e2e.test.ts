// PRD §21.7–21.9 end to end: Web SDK and Server SDK events → api (packed queue messages, server context) →
// consumer (event rows, per-actor store, gzip archive) → admin funnel / retention / breakdown / explorer /
// export, isolated per product; leaving the product erases the user's analytics and the export excludes them.
import { createServerClient } from '@z-cloudbase/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { triggerCron } from '../local-stack/stack.ts';
import {
  admin, api, consoleToken, createProduct, createServiceKey, createWebApp, newUser, ownerToken as ownerConsoleToken, poll, stack, uniqueProductId,
} from '../src/world.ts';

let ownerToken: string;
let p: Awaited<ReturnType<typeof createProduct>>;
let q: Awaited<ReturnType<typeof createProduct>>;
let adminQ: string;
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  p = await createProduct(ownerToken, uniqueProductId('fp'));
  q = await createProduct(ownerToken, uniqueProductId('fq'));
  const uq = await newUser('analytics-admin-q');
  await admin(ownerToken, 'POST', '/team', { user_id: uq.userId, role: 'product_admin', product_id: q.productId });
  adminQ = await consoleToken(uq.login);
});

type Funnel = { steps: Array<{ event: string; actors: number }> };
const funnel = async (productId: string, token = ownerToken) =>
  admin<Funnel>(token, 'GET', `/products/${productId}/analytics/funnel?env=prod&from=${today}&to=${tomorrow}&steps=e2e_view,e2e_signup,e2e_purchase`);
const counts = (f: Funnel) => f.steps.map((s) => s.actors);
const exportText = async (productId: string, format = 'ndjson') => {
  const res = await api(`/v1/admin/products/${productId}/analytics/export?env=prod&from=${today}&to=${tomorrow}&format=${format}`, { token: ownerToken });
  expect(res.status).toBe(200);
  return res.text();
};

describe('§21.7–21.9 SDK events → consumer → funnel / retention / export', () => {
  it('collects, analyses, exports, isolates, and erases a user who leaves the product', async () => {
    // Two signed-in users on P's web app; user 1 also gets user properties.
    const u1 = await newUser('funnel-1');
    const app1 = createWebApp(u1.browser, p.prod);
    await app1.signIn();
    app1.sdk.analytics.identify();
    expect(await app1.sdk.analytics.setUserProperties({ plan: 'pro' })).toEqual({ plan: 'pro' });
    app1.sdk.analytics.track('e2e_view', { path: '/pricing?coupon=SECRET' });
    app1.sdk.analytics.track('e2e_signup');
    await app1.sdk.analytics.flush();
    const u2 = await newUser('funnel-2');
    const app2 = createWebApp(u2.browser, p.prod);
    await app2.signIn();
    app2.sdk.analytics.identify();
    app2.sdk.analytics.track('e2e_view', { path: '/pricing' });
    await app2.sdk.analytics.flush();

    // The product backend attributes the purchase to user 1 (a member); a non-member is refused per event.
    const sk = await createServiceKey(ownerToken, p.prod, ['events:write']);
    const server = createServerClient({ endpoint: stack().apiOrigin, issuer: stack().issuer, serviceKey: sk, retryBaseMs: 10 });
    server.analytics.track('e2e_purchase', { amount: 30 }, { userId: u1.userId });
    await server.flush();
    const outsider = await newUser('funnel-outsider');
    const refused = await api('/v1/events/batch', {
      key: sk, body: { events: [{ event_id: crypto.randomUUID(), event_name: 'e2e_purchase', occurred_at: new Date().toISOString(), user_id: outsider.userId }] },
    });
    expect(await refused.json()).toMatchObject({ accepted: 0, rejected: [{ code: 'membership_required' }] });

    // Funnel over the per-actor store.
    const f = await poll('funnel', async () => {
      const r = await funnel(p.productId);
      return counts(r.body).join() === '2,1,1' ? r.body : null;
    });
    expect(f.steps.map((s) => s.event)).toEqual(['e2e_view', 'e2e_signup', 'e2e_purchase']);

    // Retention: both users first seen today and active today.
    const ret = await admin<{ cohorts: Array<{ cohort: string; size: number; retained: number[] }> }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/retention?env=prod&from=${today}&to=${tomorrow}&periods=2`);
    expect(ret.body.cohorts).toEqual([{ cohort: today, size: 2, retained: [2, 0] }]);
    // Cohort filtered by a user property.
    const pro = await admin<Funnel>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/funnel?env=prod&from=${today}&to=${tomorrow}&steps=e2e_view,e2e_signup&user_property=plan:pro`);
    expect(counts(pro.body)).toEqual([1, 1]);

    // Breakdown with server-derived context; the path never keeps a query string.
    const byPath = await admin<{ rows: Array<{ value: string; events: number }> }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/breakdown?env=prod&from=${today}&to=${tomorrow}&by=path&event=e2e_view`);
    expect(byPath.body.rows).toEqual([{ value: '/pricing', events: 2, users: 2 }]);
    const bySource = await admin<{ rows: Array<{ value: string; events: number }> }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/breakdown?env=prod&from=${today}&to=${tomorrow}&by=source`);
    expect(Object.fromEntries(bySource.body.rows.map((r) => [r.value, r.events]))).toMatchObject({ server: 1 });

    // Explorer: user 1 (actor = its per-product user_key) with its properties; raw ids never appear.
    const signups = await admin<{ events: Array<{ user_key: string }> }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/events?env=prod&from=${today}&to=${tomorrow}&event=e2e_signup`);
    const key1 = signups.body.events[0]!.user_key;
    const mine = await admin<{ events: Array<{ event_name: string }>; user_properties: unknown }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/events?env=prod&from=${today}&to=${tomorrow}&actor=${encodeURIComponent(key1)}`);
    expect(mine.body.events.map((e) => e.event_name).sort()).toEqual(['e2e_purchase', 'e2e_signup', 'e2e_view']);
    expect(mine.body.user_properties).toEqual({ plan: 'pro' });
    expect(JSON.stringify(mine.body)).not.toContain(u1.userId);

    // Export from the R2 archive.
    const lines = (await exportText(p.productId)).trim().split('\n').map((l) => JSON.parse(l) as { event_name: string; user_key: string | null; properties: object });
    expect(lines.filter((l) => l.event_name.startsWith('e2e_')).length).toBe(4);
    expect(lines.filter((l) => l.user_key === key1)).toHaveLength(3);
    expect(JSON.stringify(lines)).not.toContain(u1.userId);
    const csv = await exportText(p.productId, 'csv');
    expect(csv.split('\n')[0]).toMatch(/^event_id,event_name,occurred_at/);

    // Isolation: Q sees nothing of P, Q's admin cannot query P.
    expect(counts((await funnel(q.productId)).body)).toEqual([0, 0, 0]);
    expect((await funnel(p.productId, adminQ)).status).toBe(403);
    expect((await api(`/v1/admin/products/${p.productId}/analytics/export?env=prod&from=${today}&to=${tomorrow}`, { token: adminQ })).status).toBe(403);
    expect((await exportText(q.productId)).trim()).toBe('');

    // User 1 leaves P: after the deletion pipeline its analytics are gone and exports exclude it.
    const token1 = (await app1.sdk.auth.getAccessToken())!;
    expect((await api('/v1/me/membership', { key: p.prod.publishableKey, token: token1, method: 'DELETE' })).status).toBe(204);
    await triggerCron(stack(), '*/15 * * * *');
    expect(counts((await funnel(p.productId)).body)).toEqual([1, 0, 0]);
    const after = await admin<{ events: unknown[]; user_properties: unknown }>(ownerToken, 'GET',
      `/products/${p.productId}/analytics/events?env=prod&from=${today}&to=${tomorrow}&actor=${encodeURIComponent(key1)}`);
    expect(after.body).toMatchObject({ events: [], user_properties: null });
    const exported = await exportText(p.productId);
    expect(exported).not.toContain(key1);
    expect(exported).toContain('e2e_view'); // user 2's event stays
  });
});
