// Plan, confirmation and execution of `pnpm platform:destroy`. Pure of any wrangler import: the runner
// is injected, so the tests drive it with a fake and never reach Cloudflare.
import { resourceNames } from './wrangler.ts';

export type Runner = (args: string[]) => Promise<string>;

export type StepKind = 'worker' | 'queue-consumer' | 'queue' | 'd1' | 'r2';

export interface Step {
  kind: StepKind;
  name: string;
  /** wrangler arguments of the delete. */
  args: string[];
  /** Shown in the plan. */
  note?: string;
}

/** Everything a deployment owns, in deletion order (dependents first). */
export function buildPlan(prefix: string): { steps: Step[]; unsupported: string[] } {
  const n = resourceNames(prefix);
  const steps: Step[] = [];
  // Workers that bind others go first; identity is the target of the service bindings.
  for (const w of [n.console, n.api, n.consumer, n.identity]) {
    steps.push({ kind: 'worker', name: w, args: ['delete', w, '--force'], note: 'custom domains / routes and secrets go with it' });
  }
  const queues = [n.logs, n.events, n.logsDlq, n.eventsDlq];
  for (const q of queues) steps.push({ kind: 'queue-consumer', name: `${q} <- ${n.consumer}`, args: ['queues', 'consumer', 'remove', q, n.consumer] });
  for (const q of queues) steps.push({ kind: 'queue', name: q, args: ['queues', 'delete', q] });
  for (const db of [n.platformDb, n.ingestDb]) {
    steps.push({ kind: 'd1', name: db, args: ['d1', 'delete', db, '-y'], note: 'irreversible, Time Travel history is lost too (back up with `wrangler d1 export` first)' });
  }
  for (const b of [n.storage, n.archive]) {
    steps.push({ kind: 'r2', name: b, args: ['r2', 'bucket', 'delete', b], note: 'must be empty: if not, an expire-after-1-day rule is added and the command has to be re-run later' });
  }
  return { steps, unsupported: [`Analytics Engine dataset ${n.dataset} (cannot be deleted; it expires with the retention period)`] };
}

export function formatPlan(prefix: string, accountId: string | undefined): string {
  const { steps, unsupported } = buildPlan(prefix);
  const lines = [`Deployment "${prefix}" in account ${accountId ?? '(resolved when it runs)'} — this will delete:`];
  for (const s of steps) lines.push(`  ${s.kind.padEnd(14)} ${s.name}${s.note ? `   [${s.note}]` : ''}`);
  lines.push(`  record         .deploy/${prefix}.json (local, only when everything above is gone)`);
  lines.push('', 'Not deleted:', ...unsupported.map((u) => `  ${u}`));
  return lines.join('\n');
}

/**
 * Confirmation rule: the exact prefix must be typed (TTY) or given with --confirm (no TTY).
 * Returns an error message, or null when destruction may proceed.
 */
export function checkConfirmation(prefix: string, o: { confirmFlag?: string; typed?: string; interactive: boolean }): string | null {
  if (o.confirmFlag !== undefined) return o.confirmFlag === prefix ? null : `--confirm "${o.confirmFlag}" does not match the prefix "${prefix}"`;
  if (!o.interactive) return `not an interactive terminal: pass --confirm ${prefix} to confirm`;
  return o.typed === prefix ? null : 'confirmation does not match the prefix; nothing was deleted';
}

export type Outcome = 'deleted' | 'missing' | 'pending' | 'failed';
export interface StepResult { step: Step; outcome: Outcome; detail?: string }

const NOT_FOUND = /not found|does not exist|doesn't exist|no such|could not find|10007|10006|11000|7404/i;
const NOT_EMPTY = /not empty|10008/i;
const ALREADY = /already exists/i;

export const LIFECYCLE_RULE = 'destroy-expire-all';

/** Run every step in order; a failure does not stop the others (the command is safe to re-run). */
export async function executePlan(prefix: string, run: Runner, log: (m: string) => void = () => {}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of buildPlan(prefix).steps) {
    let result: StepResult;
    try {
      await run(step.args);
      result = { step, outcome: 'deleted' };
    } catch (e) {
      const text = e instanceof Error ? `${(e as { output?: string }).output ?? ''}\n${e.message}` : String(e);
      if (step.kind === 'r2' && NOT_EMPTY.test(text)) result = await scheduleEmptying(step, run);
      else if (NOT_FOUND.test(text)) result = { step, outcome: 'missing' };
      else result = { step, outcome: 'failed', detail: text.trim().split('\n').slice(0, 4).join(' | ') };
    }
    log(`  ${result.outcome.padEnd(8)} ${step.kind} ${step.name}${result.detail ? `: ${result.detail}` : ''}`);
    results.push(result);
  }
  return results;
}

/** wrangler cannot list or bulk-delete objects: let R2's lifecycle expire everything, delete the bucket on the next run. */
async function scheduleEmptying(step: Step, run: Runner): Promise<StepResult> {
  try {
    await run(['r2', 'bucket', 'lifecycle', 'add', step.name, LIFECYCLE_RULE, '', '--expire-days', '1', '--abort-multipart-days', '1', '--force']);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!ALREADY.test(text)) return { step, outcome: 'failed', detail: `bucket not empty and the lifecycle rule could not be added: ${text.split('\n')[0]}` };
  }
  return { step, outcome: 'pending', detail: 'not empty: every object now expires after 1 day; run the same command again in ~24 h (or empty it yourself, e.g. with an S3 client, and run it again)' };
}

export const isComplete = (results: StepResult[]) => results.every((r) => r.outcome === 'deleted' || r.outcome === 'missing');
