import type { IdentityRpcApi } from '@z-cloudbase/contracts';

/**
 * Typed access to the identity worker's `IdentityRpc` entrypoint (service binding IDENTITY).
 * Tests replace it with `vi.mock('../src/identity.ts', ...)`, same as the api worker.
 */
export function identity(env: Env): IdentityRpcApi {
  return env.IDENTITY as unknown as IdentityRpcApi;
}
