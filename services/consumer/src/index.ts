import { queueRole } from './archive.ts';
import { DAILY_CRON, purgeExpired, pruneSubstitute, reapStalePendingUploads, reclaimAnonymous } from './cron.ts';
import { processDueRequests } from './deletion.ts';
import { handleDlq } from './dlq.ts';
import { handleEvents } from './events.ts';
import { handleLogs } from './logs.ts';
import { expireBans, expireImpersonations, pruneWebhooks, retryWebhooks } from './user-admin.ts';

// Every named export of the entry module is a workerd entrypoint, so only entrypoint classes are
// exported here (constants and helpers live in their own modules).
export { ConsumerOps } from './ops.ts';

export default {
  async queue(batch, env, _ctx) {
    switch (queueRole(batch.queue)) {
      case 'logs':
        return handleLogs(batch, env);
      case 'events':
        return handleEvents(batch, env);
      case 'logsDlq':
      case 'eventsDlq':
        return handleDlq(batch, env);
      default:
        // Unknown queue: retry so the message is not silently acked and lost.
        console.error(JSON.stringify({ msg: 'message from unexpected queue', queue: batch.queue }));
        batch.retryAll();
    }
  },
  async scheduled(controller, env, _ctx) {
    // Independent jobs: one failing must not starve the others (failures are logged, next tick retries).
    const jobs: Array<[string, () => Promise<unknown>]> = [
      ['purge', () => purgeExpired(env)],
      ['reap_pending_uploads', () => reapStalePendingUploads(env)],
      // PRD §21.5 / §21.6 on the same schedules (Workers Free allows 5 cron triggers per account).
      ['expire_impersonations', () => expireImpersonations(env)],
      ['expire_bans', () => expireBans(env)],
    ];
    if (controller.cron === DAILY_CRON) {
      jobs.push(['reclaim_anonymous', () => reclaimAnonymous(env)], ['prune_substitute', () => pruneSubstitute(env)], ['prune_webhooks', () => pruneWebhooks(env)]);
    }
    jobs.push(['deletion_pipeline', () => processDueRequests(env)], ['webhook_retries', () => retryWebhooks(env)]);
    for (const [name, job] of jobs) {
      try {
        await job();
      } catch (err) {
        console.error(JSON.stringify({ msg: 'cron job failed', job: name, error: String(err) }));
      }
    }
  },
} satisfies ExportedHandler<Env>;
