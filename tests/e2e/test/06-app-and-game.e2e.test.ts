// PRD §15 item 12: an ordinary Web App and a Web Game both run on the same Web SDK and HTTP API,
// without registering any business table (or event schema) with the platform.
import { beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../src/browser.ts';
import { d1 } from '../local-stack/stack.ts';
import {
  admin, createBucket, createProduct, createWebApp, newUser, ownerToken as ownerConsoleToken, poll, stack, uniqueProductId, type ProductEnv,
} from '../src/world.ts';

let ownerToken: string;
let webApp: Awaited<ReturnType<typeof createProduct>>;
let webGame: Awaited<ReturnType<typeof createProduct>>;
let tablesBefore: string[];

const tables = async () => [
  ...(await d1<{ name: string }>(stack(), 'platform', `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)).map((r) => `platform.${r.name}`),
  ...(await d1<{ name: string }>(stack(), 'ingest', `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)).map((r) => `ingest.${r.name}`),
];
const top = async (p: ProductEnv) =>
  (await admin<{ top_events: Array<{ name: string; count: number }> }>(ownerToken, 'GET', `/products/${p.productId}/analytics?env=${p.env}`)).body.top_events;

beforeAll(async () => {
  ownerToken = ownerConsoleToken();
  tablesBefore = await tables();
  webApp = await createProduct(ownerToken, uniqueProductId('notes'), { name: 'Notes (web app)' });
  webGame = await createProduct(ownerToken, uniqueProductId('game'), { name: 'Puzzle (web game)' });
  await createBucket(ownerToken, webApp.prod, 'attachments');
});

describe('§15-12 one SDK for a Web App and a Web Game', () => {
  it('web app: email account, redirect sign-in, profile, file upload and page analytics', async () => {
    const u = await newUser('notes');
    const app = createWebApp(u.browser, webApp.prod);
    await app.signIn();
    expect(await app.sdk.auth.getUser()).toMatchObject({ user_id: u.userId, anonymous: false, product_id: webApp.productId });
    const file = await app.sdk.storage.createUpload({ bucket: 'attachments', file: new Blob(['meeting notes'], { type: 'text/plain' }), filename: 'notes.txt' });
    const { url } = await app.sdk.storage.getDownloadUrl(file.id);
    expect(await (await fetch(url)).text()).toBe('meeting notes');
    app.sdk.analytics.identify();
    app.sdk.analytics.track('page_view', { path: '/notes' });
    app.sdk.analytics.track('note_saved', { words: 2 });
    await app.sdk.analytics.flush();
    await poll('web app events', async () => (await top(webApp.prod)).some((e) => e.name === 'note_saved'));
  });

  it('web game: anonymous guest, session kept across reloads, gameplay events and crash reports', async () => {
    // The SDK's guest entry: no login page, an anonymous platform account, a code for the game.
    const browser = new Browser(stack().issuer);
    const game = createWebApp(browser, webGame.prod, { persistRefreshToken: true });
    const guestId = (await game.signIn(undefined, { guest: true })).id;
    expect(browser.loginPrompts).toEqual([]);
    expect(await game.sdk.auth.getUser()).toMatchObject({ user_id: guestId, anonymous: true });

    game.sdk.analytics.track('level_start', { level: 1 });
    game.sdk.analytics.track('level_complete', { level: 1, score: 1200, stars: 3 });
    await game.sdk.analytics.flush();
    await game.sdk.logs.captureError(new Error('WebGL context lost'));

    const reloaded = createWebApp(browser, webGame.prod, { persistRefreshToken: true, tab: game.tab });
    expect(await reloaded.sdk.auth.getUser()).toMatchObject({ user_id: guestId });
    await poll('game events', async () => (await top(webGame.prod)).some((e) => e.name === 'level_complete'));
    // The two products' analytics stay apart.
    expect((await top(webApp.prod)).some((e) => e.name === 'level_complete')).toBe(false);
  });

  it('neither product registered a table or an event schema with the platform', async () => {
    expect(await tables()).toEqual(tablesBefore);
    for (const p of [webApp.prod, webGame.prod]) {
      const schemas = await admin<{ event_schemas: unknown[] }>(ownerToken, 'GET', `/products/${p.productId}/environments/prod/event-schemas`);
      expect(schemas.body.event_schemas).toEqual([]);
    }
  });
});
