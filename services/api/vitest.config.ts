import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig(async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const migrations = await readD1Migrations(path.join(root, 'database/migrations'));
  const ingestMigrations = await readD1Migrations(path.join(root, 'database/ingest-migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, TEST_INGEST_MIGRATIONS: ingestMigrations, UPLOAD_SIGNING_SECRET: 'test-upload-signing-secret' },
          serviceBindings: { IDENTITY: () => new Response("identity stub: inject JWKS in tests", { status: 501 }) },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
