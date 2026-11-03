import {
  ApiError, BROWSER_ERROR_MAX_BYTES, BrowserErrorInput, LOGS_MAX_BATCH_BYTES, LOGS_MAX_PER_BATCH, LOG_MAX_ATTRIBUTE_KEYS,
  LOG_MAX_ENTRY_BYTES, LogBatchRequest, LogEntryInput, type BatchRejection, type LogQueueMessage,
} from '@z-cloudbase/contracts';
import { redact } from '@z-cloudbase/security';
import { Hono } from 'hono';
import type { AppEnv } from '../../context.ts';
import { withCredential } from '../../middleware/auth.ts';
import { serviceScopeOnly } from '../../lib/ingest/auth.ts';
import { jsonBytes, readBatchBody } from '../../lib/ingest/body.ts';
import { sendInChunks } from '../../lib/ingest/queue.ts';
import { ingestRateLimit } from '../../lib/ingest/ratelimit.ts';

export const logsRoutes = new Hono<AppEnv>();

const reject = (index: number, code: string, message: string): BatchRejection => ({ index, code, message });

/** Server entries (service key): sensitive attribute keys are redacted before they reach the queue. */
function parseServerEntry(raw: unknown, index: number): LogEntryInput | BatchRejection {
  if (jsonBytes(raw) > LOG_MAX_ENTRY_BYTES) return reject(index, 'payload_too_large', `Entry exceeds ${LOG_MAX_ENTRY_BYTES} bytes`);
  const parsed = LogEntryInput.safeParse(raw);
  if (!parsed.success) return reject(index, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid entry');
  if (Object.keys(parsed.data.attributes).length > LOG_MAX_ATTRIBUTE_KEYS) {
    return reject(index, 'validation_failed', `At most ${LOG_MAX_ATTRIBUTE_KEYS} attributes`);
  }
  return { ...parsed.data, attributes: redact(parsed.data.attributes) };
}

/** Browser reports (publishable key): only a fixed error shape is accepted; level is always 'error'. */
function parseBrowserReport(raw: unknown, index: number): LogEntryInput | BatchRejection {
  if (jsonBytes(raw) > BROWSER_ERROR_MAX_BYTES) return reject(index, 'payload_too_large', `Report exceeds ${BROWSER_ERROR_MAX_BYTES} bytes`);
  const parsed = BrowserErrorInput.safeParse(raw);
  if (!parsed.success) return reject(index, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid report');
  const { message, stack, url, timestamp, request_id } = parsed.data;
  return {
    level: 'error',
    timestamp,
    message,
    event_name: 'browser_error',
    ...(request_id ? { request_id } : {}),
    attributes: { ...(stack ? { stack } : {}), ...(url ? { url } : {}) },
  };
}

// POST /v1/logs/batch — PRD §4.4. Service key (logs:write): server logs. Publishable key: browser error reports.
logsRoutes.post(
  '/batch',
  withCredential({ allow: ['publishable', 'service'] }),
  serviceScopeOnly('logs:write'),
  ingestRateLimit('logs'),
  async (c) => {
    const cred = c.get('cred');
    const body = LogBatchRequest.safeParse(await readBatchBody(c.req.raw, LOGS_MAX_BATCH_BYTES));
    if (!body.success) throw new ApiError('validation_failed', 'Body must be {"logs": [...]}', { issues: body.error.issues.map((i) => i.message) });
    if (body.data.logs.length > LOGS_MAX_PER_BATCH) throw new ApiError('payload_too_large', `At most ${LOGS_MAX_PER_BATCH} entries per batch`);

    const source = cred.kind === 'service' ? 'server' : 'browser';
    const parse = source === 'server' ? parseServerEntry : parseBrowserReport;
    const receivedAt = new Date().toISOString();
    const messages: LogQueueMessage[] = [];
    const rejected: BatchRejection[] = [];
    body.data.logs.forEach((raw, index) => {
      const r = parse(raw, index);
      if ('code' in r) rejected.push(r);
      else messages.push({ product_id: cred.productId, environment: cred.env, source, received_at: receivedAt, ingest_request_id: c.get('requestId'), entry: r });
    });

    if (messages.length > 0) {
      try {
        await sendInChunks(c.env.LOGS_QUEUE, messages);
      } catch (err) {
        // Not silent: surfaced as a retryable 503 and logged for loss tracking (PRD §4.4).
        console.error(JSON.stringify({ request_id: c.get('requestId'), msg: 'logs enqueue failed', product: cred.productEnvId, error: String(err) }));
        throw new ApiError('unavailable', 'Log queue unavailable, retry later');
      }
    }
    return c.json({ accepted: messages.length, rejected }, 202);
  },
);
