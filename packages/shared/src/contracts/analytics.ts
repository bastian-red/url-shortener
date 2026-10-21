import { z } from 'zod';

import { instantSchema } from './primitives';

/**
 * Analytics contracts.
 *
 * Every number here is read from `click_rollups_hourly`, never from the raw
 * clicks table, which is what keeps a report at a million clicks inside its
 * budget (README: a report over 1,000,000 clicks under 150 ms at p95). The finest grain is therefore one hour, and
 * the API refuses a range that does not start and end on an hour boundary
 * rather than silently widening it.
 */

/** A report covers at most 90 days: three monthly partitions. */
export const MAX_RANGE_DAYS = 90;

export const DIMENSIONS = ['country', 'device', 'browser', 'os', 'referrer'] as const;
export const dimensionSchema = z.enum(DIMENSIONS);

/**
 * An IANA zone the database knows. Day buckets and the hour-of-week grid are
 * cut in the VIEWER's zone: a Santiago author's "Tuesday" starts at 03:00 UTC,
 * and a UTC-only report would put their lunchtime peak on the wrong row.
 */
export const timeZoneSchema = z
  .string()
  .max(64)
  .regex(/^(UTC|[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)*)$/u, 'an IANA time zone')
  .default('UTC');

export const analyticsQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    tz: timeZoneSchema,
    includeBots: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true')
      .default(false),
  })
  .refine((value) => Date.parse(value.from) < Date.parse(value.to), 'from must precede to')
  .refine(
    (value) => Date.parse(value.from) % 3_600_000 === 0 && Date.parse(value.to) % 3_600_000 === 0,
    'from and to must fall on an hour boundary (the rollups are hourly)',
  )
  .refine(
    (value) => Date.parse(value.to) - Date.parse(value.from) <= MAX_RANGE_DAYS * 86_400_000,
    `a range of at most ${MAX_RANGE_DAYS} days`,
  );

export const breakdownRowSchema = z.object({
  /** Stable key: ISO country code, device class, browser family, host. `""` is unknown. */
  key: z.string(),
  clicks: z.number().int().nonnegative(),
});

export const analyticsSchema = z.object({
  from: instantSchema,
  to: instantSchema,
  tz: z.string(),
  bucket: z.enum(['hour', 'day']),
  totals: z.object({
    clicks: z.number().int().nonnegative(),
    /** Sum of per-hour distinct visitors: a visitor active in two hours counts twice. */
    visitors: z.number().int().nonnegative(),
    bots: z.number().int().nonnegative(),
  }),
  /** Every bucket in the range, zero-filled, so a chart's x axis has no gaps. */
  series: z.array(z.object({ t: instantSchema, clicks: z.number().int().nonnegative() })),
  breakdowns: z.object({
    country: z.array(breakdownRowSchema),
    device: z.array(breakdownRowSchema),
    browser: z.array(breakdownRowSchema),
    os: z.array(breakdownRowSchema),
    referrer: z.array(breakdownRowSchema),
  }),
  /** 7 rows (Monday first) of 24 hourly counts, in `tz`. */
  hourOfWeek: z.array(z.array(z.number().int().nonnegative()).length(24)).length(7),
});

/** One click as the live tape shows it. No IP, no visitor hash: it goes to a browser. */
export const liveClickSchema = z.object({
  id: z.string(),
  linkId: z.string(),
  at: instantSchema,
  country: z.string(),
  device: z.string(),
  browser: z.string(),
  os: z.string(),
  referrer: z.string(),
  bot: z.boolean(),
});

/** Hour buckets up to three days, day buckets beyond: 72 points or 90 at most. */
export const HOURLY_MAX_HOURS = 72;

export type Dimension = z.infer<typeof dimensionSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export type Analytics = z.infer<typeof analyticsSchema>;
export type LiveClick = z.infer<typeof liveClickSchema>;
