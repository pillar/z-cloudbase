import { defineConfig } from 'vitest/config';

// One shared local stack (globalSetup); files run one after another against it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
    globalSetup: ['./src/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
