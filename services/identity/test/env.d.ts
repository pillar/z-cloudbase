import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      TEST_INGEST_MIGRATIONS: D1Migration[];
    }
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** Fake SMTP peer of test-node/smtp-peer.ts: SMTP port and the URL of its recorded sessions. */
    smtpPeer: { port: number; transcripts: string };
  }
}
