import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Test-only values; never real credentials (PRD D10). AUTH_SECRET is also put in
// process.env because wrangler validates `secrets.required` when it reads the config.
const TEST_AUTH_SECRET = 'test-only-auth-secret-0123456789abcdefghijklmnop';
process.env.AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.SETUP_TOKEN ??= 'test-only-setup-token';

export default defineConfig(async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const migrations = await readD1Migrations(path.join(root, 'database/migrations'));
  const ingestMigrations = await readD1Migrations(path.join(root, 'database/ingest-migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_INGEST_MIGRATIONS: ingestMigrations,
            AUTH_SECRET: TEST_AUTH_SECRET,
            SETUP_TOKEN: 'test-only-setup-token',
            GOOGLE_CLIENT_ID: 'mock-google-client-id',
            GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
            APPLE_CLIENT_ID: 'mock-apple-service-id',
            APPLE_CLIENT_SECRET: 'mock-apple-client-secret',
          },
        },
      }),
    ],
    // test-node/smtp-peer.ts: a fake SMTP server in Node for the SMTP transport tests (outside workerd).
    test: { setupFiles: ['./test/apply-migrations.ts'], globalSetup: ['./test-node/smtp-peer.ts'] },
  };
});
