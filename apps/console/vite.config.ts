import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// index.html uses %VITE_PLATFORM_NAME%; Vite leaves unset variables verbatim, so give it the default.
process.env.VITE_PLATFORM_NAME ||= 'z-cloudbase';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173 },
  // Section pages are lazy chunks: scan them at startup so the dev server pre-bundles their dependencies
  // up front instead of reloading the page the first time one is opened.
  optimizeDeps: { entries: ['index.html', 'src/pages/*.tsx', 'src/pages/analytics/*.tsx'] },
  // Pure-logic tests (PKCE, OIDC helpers, API client) run in Node; no DOM needed.
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
