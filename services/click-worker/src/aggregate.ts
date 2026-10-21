import type { Dimension } from '@links/shared';

import type { EnrichedClick } from './enrich';

/**
 * Rollup deltas for a set of NEW clicks. Pure, so the "rollups equal a recount"
 * property (SPECS outcome 6) is tested here over random batch splits, with no
 * database.
 *
 * Visitors are not here: whether a visitor is new in an hour depends on what
 * earlier batches saw, which only the database knows (visitor_hours).
 */

export interface HourDelta {
  linkId: string;
  hour: Date;
  clicks: number;
  bots: number;
}

export interface RollupDelta {
  linkId: string;
  hour: Date;
  isBot: boolean;
  dimension: Dimension;
  key: string;
  clicks: number;
}

export interface Deltas {
  hours: HourDelta[];
  rollups: RollupDelta[];
}

const DIMENSION_OF: ReadonlyArray<[Dimension, (c: EnrichedClick) => string]> = [
  ['country', (c) => c.country],
  ['device', (c) => c.device],
  ['browser', (c) => c.browser],
  ['os', (c) => c.os],
  ['referrer', (c) => c.referrer],
];

/**
 * Deltas, SORTED by primary key. The order is load-bearing: two workers
 * upserting overlapping rows lock them in the order each statement lists them,
 * and two statements listing the same rows in different orders can deadlock.
 * Sorted input means every worker takes the locks in the same order.
 */
export function aggregate(clicks: readonly EnrichedClick[]): Deltas {
  const hours = new Map<string, HourDelta>();
  const rollups = new Map<string, RollupDelta>();

  for (const c of clicks) {
    const hourKey = `${c.linkId}\u0000${c.hour.toISOString()}`;
    let h = hours.get(hourKey);
    if (h === undefined) {
      h = { linkId: c.linkId, hour: c.hour, clicks: 0, bots: 0 };
      hours.set(hourKey, h);
    }
    if (c.isBot) h.bots += 1;
    else h.clicks += 1;

    for (const [dimension, read] of DIMENSION_OF) {
      const key = read(c);
      const rollupKey = `${hourKey}\u0000${c.isBot ? 1 : 0}\u0000${dimension}\u0000${key}`;
      const r = rollups.get(rollupKey);
      if (r === undefined) {
        rollups.set(rollupKey, {
          linkId: c.linkId,
          hour: c.hour,
          isBot: c.isBot,
          dimension,
          key,
          clicks: 1,
        });
      } else {
        r.clicks += 1;
      }
    }
  }

  const byKey = <T>(map: Map<string, T>): T[] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
  return { hours: byKey(hours), rollups: byKey(rollups) };
}

/** Sum two delta sets: what applying them one after the other does to the tables. */
export function merge(a: Deltas, b: Deltas): Deltas {
  return {
    hours: mergeBy(
      a.hours,
      b.hours,
      (d) => `${d.linkId}|${d.hour.toISOString()}`,
      (x, y) => ({
        ...x,
        clicks: x.clicks + y.clicks,
        bots: x.bots + y.bots,
      }),
    ),
    rollups: mergeBy(
      a.rollups,
      b.rollups,
      (d) => `${d.linkId}|${d.hour.toISOString()}|${String(d.isBot)}|${d.dimension}|${d.key}`,
      (x, y) => ({ ...x, clicks: x.clicks + y.clicks }),
    ),
  };
}

function mergeBy<T>(a: T[], b: T[], key: (t: T) => string, add: (x: T, y: T) => T): T[] {
  const out = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const k = key(item);
    const existing = out.get(k);
    out.set(k, existing === undefined ? item : add(existing, item));
  }
  return [...out.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
}
