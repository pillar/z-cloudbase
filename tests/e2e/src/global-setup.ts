// Starts the whole local platform once for the e2e suite: fresh throwaway state, migrations,
// operator setup (console client + first administrator), then the identity / api / consumer workers in ONE
// `wrangler dev` process (see local-stack/stack.ts). Torn down and deleted afterwards
// (set E2E_KEEP_STATE=1 to keep the state directory and wrangler log for debugging).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { bootstrapRunning } from '../local-stack/bootstrap.ts';
import { applyMigrations, startStack, type StackInfo } from '../local-stack/stack.ts';
import { CONSOLE_ORIGIN } from './constants.ts';
import { consoleToken as consoleTokenAt } from './world.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: StackInfo;
    owner: { email: string; password: string; userId: string; consoleToken: string };
  }
}

export default async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudbase-e2e-'));
  await applyMigrations(dir);
  const running = await startStack({ persistTo: dir, logFile: path.join(dir, 'wrangler.log') });
  console.log(`[e2e] local stack on port ${running.port}; state + log in ${dir}`);
  const { stop, ...info } = running;
  try {
    // First owner: operator setup with a generated password (PRD §19.9: no public admin sign-up).
    const boot = await bootstrapRunning(info, { consoleOrigin: CONSOLE_ORIGIN, adminEmail: `owner-${Date.now()}@example.test` });
    if (!boot.admin) throw new Error('setup did not create the administrator');
    const { email, password, userId } = boot.admin;
    // One console sign-in for the whole suite: the per-account auth limit is 5 / minute.
    const consoleToken = await consoleTokenAt({ email, password }, info.issuer);
    project.provide('stack', info);
    project.provide('owner', { email, password, userId, consoleToken });
  } catch (e) {
    await stop();
    throw e;
  }
  return async () => {
    await stop();
    if (process.env.E2E_KEEP_STATE) console.log(`[e2e] kept ${dir}`);
    else await rm(dir, { recursive: true, force: true });
  };
}
