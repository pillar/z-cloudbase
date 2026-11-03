// Account deletion / export on the identity domain (PRD §19.8): session cookie, 5-minute
// re-authentication for the sensitive steps, same-origin check, owner-only one-time export links.
import { EXPORT_LINK_TTL_S, REAUTH_WINDOW_S } from '@z-cloudbase/contracts';
import { sha256Hex } from '@z-cloudbase/security';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CookieJar, auditRows, call, signUp } from './helpers.ts';

const DAY = 24 * 3600_000;

async function ageSessions(userId: string, seconds: number) {
  const row = await env.DB.prepare('SELECT createdAt FROM session WHERE userId = ? LIMIT 1').bind(userId).first<{ createdAt: string | number }>();
  const old = new Date(Date.now() - seconds * 1000);
  await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?')
    .bind(typeof row!.createdAt === 'number' ? old.getTime() : old.toISOString(), userId)
    .run();
}

async function user() {
  const jar = new CookieJar();
  const { userId } = await signUp(jar);
  return { jar, userId };
}

const errorOf = async (res: Response) => (await res.json<{ error: { code: string; details?: { reason?: string } } }>()).error;

describe('account deletion on the identity domain', () => {
  it('opens one request due after the 7-day cooldown and audits it', async () => {
    const { jar, userId } = await user();
    const res = await call('/account/deletion', { jar, method: 'POST' });
    expect(res.status).toBe(202);
    const r = await res.json<{ id: string; kind: string; scope: string; status: string; due_at: string }>();
    expect(r).toMatchObject({ kind: 'delete', scope: 'account', status: 'pending' });
    const due = Date.parse(r.due_at) - Date.now();
    expect(due).toBeGreaterThan(7 * DAY - 60_000);
    expect(due).toBeLessThanOrEqual(7 * DAY);

    const again = await call('/account/deletion', { jar, method: 'POST' });
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe(r.id);
    expect(await auditRows('account.deletion.request', r.id)).toEqual([expect.objectContaining({ actor_type: 'user', actor_id: userId })]);
  });

  it('can be cancelled while pending (JSON or form), not once processing', async () => {
    const { jar, userId } = await user();
    await call('/account/deletion', { jar, method: 'POST' });
    expect((await call('/account/deletion', { jar, method: 'DELETE' })).status).toBe(204);
    expect((await errorOf(await call('/account/deletion', { jar, method: 'DELETE' }))).code).toBe('not_found');

    await call('/account/deletion', { jar, method: 'POST' });
    const form = await call('/account/deletion/cancel', { jar, form: {} });
    expect(form.status).toBe(303);
    const list = await (await call('/account/requests', { jar })).json<{ requests: { status: string }[] }>();
    expect(list.requests.map((x) => x.status)).toEqual(['cancelled', 'cancelled']);

    await call('/account/deletion', { jar, method: 'POST' });
    await env.DB.prepare(`UPDATE deletion_requests SET status = 'processing' WHERE user_id = ? AND status = 'pending'`).bind(userId).run();
    expect((await errorOf(await call('/account/deletion', { jar, method: 'DELETE' }))).code).toBe('not_found');
  });

  it('requires a session, a recent sign-in and a same-origin request', async () => {
    expect((await errorOf(await call('/account/deletion', { method: 'POST' }))).code).toBe('unauthenticated');
    expect((await errorOf(await call('/account/requests'))).code).toBe('unauthenticated');

    const { jar, userId } = await user();
    const crossSite = await call('/account/deletion', { jar, method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    const crossSiteCancel = await call('/account/deletion', { jar, method: 'DELETE', headers: { origin: 'https://evil.example' } });
    expect(crossSiteCancel.status).toBe(403);

    await ageSessions(userId, REAUTH_WINDOW_S + 60);
    for (const path of ['/account/deletion', '/account/export']) {
      const res = await call(path, { jar, method: 'POST' });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).details?.reason).toBe('reauth_required');
    }
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM deletion_requests WHERE user_id = ?').bind(userId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});


/** An export request of the user, completed with an archive object (what the consumer cron does). */
async function completedExport(jar: CookieJar, userId: string) {
  const r = await (await call('/account/export', { jar, method: 'POST' })).json<{ id: string }>();
  const ref = `exports/${userId}/${r.id}.json`;
  await env.ARCHIVE.put(ref, JSON.stringify({ identity: { user_id: userId } }));
  await env.DB.prepare(`UPDATE deletion_requests SET status = 'completed', completed_at = ?, result_ref = ? WHERE id = ?`)
    .bind(Date.now(), ref, r.id).run();
  return { id: r.id, ref };
}

async function createLink(jar: CookieJar, id: string) {
  const res = await call(`/account/exports/${id}/link`, { jar, method: 'POST' });
  expect(res.status).toBe(201);
  const body = await res.json<{ url: string; expires_at: string }>();
  return { ...body, path: new URL(body.url).pathname };
}

describe('data export on the identity domain', () => {
  it('opens an export due now; no link exists before it is completed and the archive path is never exposed', async () => {
    const { jar, userId } = await user();
    const res = await call('/account/export', { jar, method: 'POST' });
    expect(res.status).toBe(202);
    const r = await res.json<{ id: string; status: string; due_at: string }>();
    expect(Date.parse(r.due_at)).toBeLessThanOrEqual(Date.now());
    expect((await errorOf(await call(`/account/exports/${r.id}/link`, { jar, method: 'POST' }))).code).toBe('not_found');

    const ref = `exports/${userId}/${r.id}.json`;
    await env.ARCHIVE.put(ref, '{}');
    await env.DB.prepare(`UPDATE deletion_requests SET status = 'completed', completed_at = ?, result_ref = ? WHERE id = ?`)
      .bind(Date.now(), ref, r.id).run();
    const list = await (await call('/account/requests', { jar })).json<{ requests: Record<string, unknown>[] }>();
    expect(list.requests[0]).toMatchObject({ id: r.id, status: 'completed' });
    expect(JSON.stringify(list)).not.toContain(ref);
  });

  it('downloads a completed export once through a 15-minute link stored only as a hash; both steps are audited', async () => {
    const { jar, userId } = await user();
    const { id } = await completedExport(jar, userId);
    const link = await createLink(jar, id);
    expect(link.url.startsWith(`${env.ISSUER}/account/export-links/`)).toBe(true);
    const ttl = Date.parse(link.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(EXPORT_LINK_TTL_S * 1000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(EXPORT_LINK_TTL_S * 1000);

    const token = link.path.split('/').pop()!;
    const stored = await env.DB.prepare('SELECT token_hash FROM export_links WHERE request_id = ?').bind(id).all<{ token_hash: string }>();
    expect(stored.results).toEqual([{ token_hash: await sha256Hex(token) }]);

    const dl = await call(link.path, { jar });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(dl.headers.get('cache-control')).toBe('no-store');
    expect(await dl.json()).toEqual({ identity: { user_id: userId } });

    // Single use; and the former direct download route is gone.
    expect((await errorOf(await call(link.path, { jar }))).code).toBe('not_found');
    expect((await call(`/account/exports/${id}`, { jar })).status).toBe(404);
    expect(await auditRows('account.export.link_create', id)).toEqual([expect.objectContaining({ actor_type: 'user', actor_id: userId })]);
    expect(await auditRows('account.export.download', id)).toHaveLength(1);
  });

  it("refuses another user's link (without consuming it), an expired link, and a request without a session", async () => {
    const { jar, userId } = await user();
    const { id } = await completedExport(jar, userId);
    const other = await user();

    const link = await createLink(jar, id);
    expect((await call(link.path, { jar: other.jar })).status).toBe(404);
    expect((await errorOf(await call(link.path))).code).toBe('unauthenticated');
    // Opened in a browser without a session: the login page.
    const nav = await call(link.path, { headers: { accept: 'text/html' } });
    expect(nav.status).toBe(302);
    expect(nav.headers.get('location')).toBe('/login');
    expect((await call(link.path, { jar })).status).toBe(200);

    const expired = await createLink(jar, id);
    await env.DB.prepare('UPDATE export_links SET expires_at = ? WHERE token_hash = ?')
      .bind(Date.now() - 1, await sha256Hex(expired.path.split('/').pop()!)).run();
    expect((await call(expired.path, { jar })).status).toBe(404);
    expect((await call('/account/export-links/not-a-real-token', { jar })).status).toBe(404);
    expect(await auditRows('account.export.download', id)).toHaveLength(1);
  });

  it('creating a link needs the owner and a recent sign-in; the account page form leads straight to a download', async () => {
    const { jar, userId } = await user();
    const { id } = await completedExport(jar, userId);
    const other = await user();
    expect((await errorOf(await call(`/account/exports/${id}/link`, { jar: other.jar, method: 'POST' }))).code).toBe('not_found');
    expect((await call(`/account/exports/${id}/link`, { jar, method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);

    const page = await (await call('/account', { jar })).text();
    expect(page).toContain(`action="/account/exports/${id}/link"`);
    const form = await call(`/account/exports/${id}/link`, { jar, form: {} });
    expect(form.status).toBe(303);
    const location = form.headers.get('location')!;
    expect(location).toMatch(/^\/account\/export-links\/[A-Za-z0-9_-]{43}$/);
    expect((await call(location, { jar })).status).toBe(200);

    await ageSessions(userId, REAUTH_WINDOW_S + 60);
    const stale = await call(`/account/exports/${id}/link`, { jar, method: 'POST' });
    expect(stale.status).toBe(403);
    expect((await errorOf(stale)).details?.reason).toBe('reauth_required');
    // The Download button with a stale sign-in leads to the login page.
    const staleForm = await call(`/account/exports/${id}/link`, { jar, form: {} });
    expect(staleForm.status).toBe(303);
    expect(staleForm.headers.get('location')).toBe('/login');
  });

  it('concurrent downloads of one link: exactly one succeeds', async () => {
    const { jar, userId } = await user();
    const { id } = await completedExport(jar, userId);
    const link = await createLink(jar, id);
    const statuses = (await Promise.all([0, 1, 2, 3].map(() => call(link.path, { jar })))).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 404, 404, 404]);
  });
});
