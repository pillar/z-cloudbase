import { z } from 'zod';
import { USER_PROPERTY_KEY_RE } from './limits.ts';

// Analytics admin API and user properties (PRD §21.7–21.9). Request validation lives next to the
// routes; this module holds the shared shapes (console, SDKs, tests).

/** Built-in dimensions for breakdown / filter; custom ones are `prop:<key>` of a declared key. */
export const BUILTIN_DIMENSIONS = ['event_name', 'path', 'browser', 'os', 'device', 'country', 'source'] as const;
export type BuiltinDimension = (typeof BUILTIN_DIMENSIONS)[number];
export type Dimension = BuiltinDimension | `prop:${string}`;

/** Server-derived request context (never read from the body). */
export interface EventContext {
  source: 'client' | 'server';
  browser: string;
  os: string;
  device: string;
  country: string;
}

export interface FunnelResult {
  steps: Array<{ event: string; actors: number; conversion: number }>;
  window_s: number;
  from: string;
  to: string;
}

export interface RetentionResult {
  granularity: 'day' | 'week';
  periods: number;
  cohorts: Array<{ cohort: string; size: number; retained: number[] }>;
}

export interface BreakdownResult {
  by: string;
  rows: Array<{ value: string; events: number; users: number }>;
  source: 'analytics_engine' | 'd1_substitute';
}

export interface ExplorerEvent {
  event_id: string;
  event_name: string;
  occurred_at: string;
  received_at: string;
  user_key: string | null;
  anonymous_id: string | null;
  session_id: string | null;
  source: string;
  browser: string;
  os: string;
  device: string;
  country: string;
  path: string;
  dims: Record<string, string>;
  properties: Record<string, unknown> | null;
  properties_truncated: boolean;
}

export interface ExplorerResult {
  events: ExplorerEvent[];
  /** Cursor for the next (older) page; null when there is none. */
  next_before: string | null;
  user_properties?: Record<string, unknown> | null;
}

export interface AnalyticsSettings {
  dimensions: string[];
  retention_days: number;
  archive_retention_days: number;
}

const Scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const UpdateAnalyticsSettingsRequest = z.object({
  dimensions: z.array(z.string().regex(USER_PROPERTY_KEY_RE)).max(3)
    .refine((d) => new Set(d).size === d.length, 'dimensions must be unique'),
});

/** POST /v1/events/user-properties. `user_id` only with a service key. */
export const UserPropertiesRequest = z.object({
  properties: z.record(z.string().regex(USER_PROPERTY_KEY_RE), Scalar),
  user_id: z.string().startsWith('usr_').max(64).optional(),
});
export type UserPropertiesRequest = z.infer<typeof UserPropertiesRequest>;
