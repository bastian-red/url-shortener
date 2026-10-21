import { z } from 'zod';

/**
 * The health shape, shared by all three services so `/status` and the E2E suite
 * parse what each one actually sends. The Go redirect service emits the same
 * JSON; `services/redirect/internal/health` is tested against
 * `contracts/fixtures/health.json`, which this schema also parses.
 */

export const healthCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'fail']),
    latencyMs: z.number().int().nonnegative(),
    /** An error MESSAGE when it failed, never a stack: this body is public. */
    detail: z.string().nullable(),
  })
  .strict();

export const SERVICE_NAMES = ['api', 'redirect', 'click-worker'] as const;

export const healthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    service: z.enum(SERVICE_NAMES),
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    checks: z.array(healthCheckSchema),
  })
  .strict();

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ServiceName = (typeof SERVICE_NAMES)[number];
