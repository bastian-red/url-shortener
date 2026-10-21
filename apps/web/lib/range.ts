/**
 * Report ranges and brush selections, in whole hours.
 *
 * The API refuses a range that does not start and end on an hour (the rollups
 * are hourly), so every range this app builds is snapped here, once, rather
 * than each caller rounding its own way.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const RANGE_PRESETS = {
  '24h': { label: 'Last 24 hours', ms: DAY_MS },
  '7d': { label: 'Last 7 days', ms: 7 * DAY_MS },
  '30d': { label: 'Last 30 days', ms: 30 * DAY_MS },
  '90d': { label: 'Last 90 days', ms: 90 * DAY_MS },
} as const;

export type RangeKey = keyof typeof RANGE_PRESETS;

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANGE_PRESETS, value);
}

/**
 * The preset ending at the END of the current hour, so the hour in progress is
 * included and a click made a minute ago is on the chart.
 */
export function presetRange(key: RangeKey, now: Date): { from: string; to: string } {
  const to = Math.ceil((now.getTime() + 1) / HOUR_MS) * HOUR_MS;
  return {
    from: new Date(to - RANGE_PRESETS[key].ms).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/**
 * A brush drag over the timeline, from two bucket indexes to a range.
 *
 * Inclusive of both ends, whichever way the drag went, and clamped to the
 * series. Each bucket spans until the next one starts; the last one spans to
 * the report's end.
 */
export function brushRange(
  buckets: readonly string[],
  reportTo: string,
  a: number,
  b: number,
): { from: string; to: string } | null {
  if (buckets.length === 0) return null;
  const last = buckets.length - 1;
  const lo = Math.max(0, Math.min(a, b, last));
  const hi = Math.min(last, Math.max(a, b, 0));
  return { from: buckets[lo]!, to: hi === last ? reportTo : buckets[hi + 1]! };
}

/** Which bucket an x position (0..width) falls in. */
export function bucketAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor((x / width) * count)));
}
