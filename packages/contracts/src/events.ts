import { z } from 'zod';
import { EVENT_NAME_RE } from './ids.ts';

// Client-supplied fields only. product_id / environment / user_id are derived
// server-side from the credential and verified token (PRD §4.5, §6.3).


const Scalar = z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]);

export const EventInput = z.object({
  event_id: z.uuid(),
  event_name: z.string().regex(EVENT_NAME_RE),
  occurred_at: z.iso.datetime({ offset: true }),
  anonymous_id: z.string().min(1).max(128).optional(),
  session_id: z.string().min(1).max(128).optional(),
  properties: z.record(z.string().max(64), Scalar).default({}),
  schema_version: z.number().int().min(1).default(1),
});
export type EventInput = z.infer<typeof EventInput>;

/** Envelope only; each event is validated individually so one bad event doesn't reject the batch. */
export const EventBatchRequest = z.object({ events: z.array(z.unknown()).min(1) });

export const BatchRejection = z.object({
  index: z.number().int(),
  code: z.string(),
  message: z.string(),
});
export type BatchRejection = z.infer<typeof BatchRejection>;

/** Non-fatal notices: accepted events whose name is not registered (dev / staging, PRD §4.5). */
export const BatchWarning = z.object({
  index: z.number().int(),
  code: z.enum(['unknown_event', 'schema_violation']),
  message: z.string(),
});
export type BatchWarning = z.infer<typeof BatchWarning>;

export const EventBatchResponse = z.object({
  accepted: z.number().int(),
  duplicate: z.number().int(),
  rejected: z.array(BatchRejection),
  warnings: z.array(BatchWarning).optional(),
});
export type EventBatchResponse = z.infer<typeof EventBatchResponse>;

/** Message placed on the events queue; identity fields are server-derived. */
export interface EventQueueMessage {
  product_id: string;
  environment: string;
  /** HMAC(user_id, product_salt) — raw user_id never leaves the API worker (PRD §19.8). */
  user_key: string | null;
  received_at: string;
  event: EventInput;
}

/**
 * Event property schema (PRD §4.5): a deliberately small subset instead of full JSON Schema.
 * Properties are flat scalars, so a field is a type list plus optional constraints.
 */
export const PROPERTY_TYPES = ['string', 'number', 'boolean', 'null'] as const;

export const PropertySpec = z.object({
  type: z.union([z.enum(PROPERTY_TYPES), z.array(z.enum(PROPERTY_TYPES)).min(1)]),
  required: z.boolean().default(false),
  max_length: z.number().int().positive().max(1024).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(100).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
});
export type PropertySpec = z.infer<typeof PropertySpec>;

export const EventPropertySchema = z.object({
  properties: z.record(z.string().max(64), PropertySpec).refine((p) => Object.keys(p).length <= 50, 'at most 50 properties'),
  /** When false, properties not listed are a violation. */
  additional_properties: z.boolean().default(true),
});
export type EventPropertySchema = z.infer<typeof EventPropertySchema>;

export const RegisterEventSchemaRequest = z.object({
  event_name: z.string().regex(EVENT_NAME_RE),
  schema_version: z.number().int().min(1),
  schema: EventPropertySchema,
});
export type RegisterEventSchemaRequest = z.infer<typeof RegisterEventSchemaRequest>;
