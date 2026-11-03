import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIFECYCLE_RULE, buildPlan, checkConfirmation, executePlan, formatPlan, isComplete } from '../lib/destroy.ts';
import { WranglerError } from '../lib/wrangler.ts';

const fake = (script: (args: string[]) => string | Error | undefined) => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const r = script(args);
    if (r instanceof Error) throw r;
    return r ?? '';
  };
  return { calls, run };
};

test('plan lists every resource of the prefix in dependency order', () => {
  const { steps, unsupported } = buildPlan('acme');
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.name}`), [
    'worker:acme-console', 'worker:acme-api', 'worker:acme-consumer', 'worker:acme-identity',
    'queue-consumer:acme-logs <- acme-consumer', 'queue-consumer:acme-events <- acme-consumer',
    'queue-consumer:acme-logs-dlq <- acme-consumer', 'queue-consumer:acme-events-dlq <- acme-consumer',
    'queue:acme-logs', 'queue:acme-events', 'queue:acme-logs-dlq', 'queue:acme-events-dlq',
    'd1:acme-platform', 'd1:acme-ingest', 'r2:acme-storage', 'r2:acme-archive',
  ]);
  assert.match(unsupported[0]!, /acme_events/);
  assert.match(formatPlan('acme', undefined), /acme-storage/);
});

test('plan never names a resource of another prefix', () => {
  const text = formatPlan('acme', '1'.repeat(32));
  assert.ok(!/z-cloudbase/.test(text));
});

test('confirmation: typed prefix, --confirm, and non-interactive refusal', () => {
  assert.equal(checkConfirmation('acme', { interactive: true, typed: 'acme' }), null);
  assert.match(checkConfirmation('acme', { interactive: true, typed: 'acm' })!, /does not match/);
  assert.match(checkConfirmation('acme', { interactive: true })!, /does not match/);
  assert.match(checkConfirmation('acme', { interactive: false })!, /--confirm acme/);
  assert.equal(checkConfirmation('acme', { interactive: false, confirmFlag: 'acme' }), null);
  assert.match(checkConfirmation('acme', { interactive: false, confirmFlag: 'other' })!, /does not match/);
});

test('executes the plan in order and reports all deleted', async () => {
  const f = fake(() => undefined);
  const results = await executePlan('acme', f.run);
  assert.equal(f.calls.length, 16);
  assert.deepEqual(f.calls[0], ['delete', 'acme-console', '--force']);
  assert.deepEqual(f.calls[4], ['queues', 'consumer', 'remove', 'acme-logs', 'acme-consumer']);
  assert.ok(isComplete(results));
});

test('already-deleted resources count as missing, other errors fail but do not stop the run', async () => {
  const f = fake((a) => {
    if (a[0] === 'delete' && a[1] === 'acme-api') return new WranglerError(a, 'Worker not found [code: 10007]', 1);
    if (a[0] === 'queues' && a[1] === 'delete' && a[2] === 'acme-logs') return new WranglerError(a, 'network down', 1);
  });
  const results = await executePlan('acme', f.run);
  assert.equal(results.find((r) => r.step.name === 'acme-api')!.outcome, 'missing');
  assert.equal(results.find((r) => r.step.name === 'acme-logs' && r.step.kind === 'queue')!.outcome, 'failed');
  assert.equal(f.calls.length, 16);
  assert.equal(isComplete(results), false);
});

test('a non-empty R2 bucket gets an expiry rule and stays pending', async () => {
  const f = fake((a) => {
    if (a.join(' ') === 'r2 bucket delete acme-storage') return new WranglerError(a, 'The bucket you tried to delete is not empty. [code: 10008]', 1);
  });
  const results = await executePlan('acme', f.run);
  const r = results.find((x) => x.step.name === 'acme-storage')!;
  assert.equal(r.outcome, 'pending');
  const rule = f.calls.find((c) => c[2] === 'lifecycle')!;
  assert.deepEqual(rule.slice(0, 5), ['r2', 'bucket', 'lifecycle', 'add', 'acme-storage']);
  assert.equal(rule[5], LIFECYCLE_RULE);
  assert.ok(rule.includes('--expire-days') && rule.includes('1'));
  assert.equal(results.find((x) => x.step.name === 'acme-archive')!.outcome, 'deleted');
  assert.equal(isComplete(results), false);
});

test('re-running with the rule already in place is still pending, not failed', async () => {
  const f = fake((a) => {
    if (a[0] === 'r2' && a[2] === 'delete') return new WranglerError(a, 'bucket is not empty', 1);
    if (a[2] === 'lifecycle') return new WranglerError(a, 'rule already exists', 1);
  });
  const results = await executePlan('acme', f.run);
  assert.equal(results.filter((r) => r.outcome === 'pending').length, 2);
});
