import { z } from 'zod';

import { healthSchema } from './health';

/**
 * `GET /status`: every service's health plus the click pipeline's numbers, for
 * the web app's /status page. Public, like /health: it reports state, never
 * data.
 */

/** A service that did not answer at all: no body to parse, so no Health. */
export const unreachableSchema = z.object({
  service: z.enum(['api', 'redirect', 'click-worker']),
  status: z.literal('unreachable'),
  detail: z.string(),
});

export const pipelineSchema = z.object({
  /** Stream entries not yet delivered to the worker group. */
  lag: z.number().int().nonnegative().nullable(),
  /** Delivered, not yet acknowledged. */
  pending: z.number().int().nonnegative(),
  streamLength: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  lastBatchAt: z.string().datetime().nullable(),
});

export const statusSchema = z.object({
  checkedAt: z.string().datetime(),
  services: z.array(z.union([healthSchema, unreachableSchema])),
  pipeline: pipelineSchema.nullable(),
});

export type Pipeline = z.infer<typeof pipelineSchema>;
export type Status = z.infer<typeof statusSchema>;
export type Unreachable = z.infer<typeof unreachableSchema>;
