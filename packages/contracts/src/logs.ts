import { z } from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const Scalar = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]);

export const LogEntryInput = z.object({
  level: z.enum(LOG_LEVELS),
  timestamp: z.iso.datetime({ offset: true }),
  message: z.string().min(1).max(4096),
  event_name: z.string().max(128).optional(),
  request_id: z.string().max(128).optional(),
  trace_id: z.string().max(128).optional(),
  attributes: z.record(z.string().max(64), Scalar).default({}),
});
export type LogEntryInput = z.infer<typeof LogEntryInput>;

export const LogBatchRequest = z.object({ logs: z.array(z.unknown()).min(1) });

/** Browser error report (publishable-key callers). Never treated as a trusted audit log. */
export const BrowserErrorInput = z.object({
  message: z.string().min(1).max(2048),
  stack: z.string().max(4096).optional(),
  url: z.string().max(1024).optional(),
  timestamp: z.iso.datetime({ offset: true }),
  request_id: z.string().max(128).optional(),
});
export type BrowserErrorInput = z.infer<typeof BrowserErrorInput>;

export type LogSource = 'server' | 'browser';

export interface LogQueueMessage {
  product_id: string;
  environment: string;
  source: LogSource;
  received_at: string;
  /** Platform request id of the ingestion call. */
  ingest_request_id: string;
  entry: LogEntryInput;
}
