/**
 * Reports, read from the rollup tables only (SPECS outcome 6).
 *
 * Four queries, run in parallel, none of which touches the raw `clicks` table:
 * the time series and totals from `link_hours`, the breakdowns and the
 * hour-of-week grid from `click_rollups`. At a million clicks on one link over
 * 30 days that is about 720 + 45,000 rows to aggregate, which is what keeps a
 * report inside its budget without a cache.
 *
 * Buckets: an HOUR is cut in UTC, a DAY in the viewer's zone. Hours are cut in
 * UTC because a local hour is ambiguous twice a year (the repeated 01:00 when
 * clocks go back would merge two hours into one bucket, and the skipped 02:00
 * would produce a bucket that does not exist). A local day has neither problem,
 * and a day cut in UTC would put a Santiago author's evening on tomorrow.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  DIMENSIONS,
  DomainError,
  HOURLY_MAX_HOURS,
  type Analytics,
  type AnalyticsQuery,
  type BreakdownRow,
  type Dimension,
  type SessionUser,
} from '@links/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { LinksService } from '../links/links.service';

/** Rows per dimension. The web app shows the top few and folds the rest into "Other". */
export const BREAKDOWN_LIMIT = 25;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function bucketFor(from: Date, to: Date): 'hour' | 'day' {
  return to.getTime() - from.getTime() <= HOURLY_MAX_HOURS * 3_600_000 ? 'hour' : 'day';
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly links: LinksService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async report(
    user: SessionUser,
    linkId: string,
    query: AnalyticsQuery,
    now = new Date(),
  ): Promise<Analytics> {
    await this.links.owned(user, linkId);
    if (!isTimeZone(query.tz)) {
      throw new DomainError('INVALID', `“${query.tz}” is not a time zone.`, { field: 'tz' });
    }
    const from = new Date(query.from);
    const to = new Date(query.to);

    // Only a range that has fully closed is cached. A range ending in the
    // current hour is still being written to, and a cached copy would hide the
    // click the author just made from the chart they are looking at.
    const closed = to.getTime() <= Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const cacheKey = `analytics:v1:${linkId}:${query.from}:${query.to}:${query.tz}:${String(query.includeBots)}`;
    if (closed) {
      const hit = await this.redis.client.get(cacheKey).catch(() => null);
      if (hit !== null) return JSON.parse(hit) as Analytics;
    }

    const report = await this.compute(linkId, from, to, query.tz, query.includeBots);
    if (closed) {
      await this.redis.client
        .set(cacheKey, JSON.stringify(report), 'EX', this.config.analyticsCacheTtlSeconds)
        .catch(() => undefined);
    }
    return report;
  }

  async compute(
    linkId: string,
    from: Date,
    to: Date,
    tz: string,
    includeBots: boolean,
  ): Promise<Analytics> {
    const bucket = bucketFor(from, to);
    const truncZone = bucket === 'hour' ? 'UTC' : tz;
    const db = this.prisma.client;

    const [series, totals, breakdown, week] = await Promise.all([
      db.$queryRaw<{ t: Date; clicks: number }[]>`
        WITH buckets AS (
          SELECT g AS local_t
            FROM generate_series(
                   date_trunc(${bucket}, ${from}::timestamptz AT TIME ZONE ${truncZone}),
                   date_trunc(${bucket}, (${to}::timestamptz - INTERVAL '1 millisecond') AT TIME ZONE ${truncZone}),
                   ('1 ' || ${bucket})::interval) AS g
        ), counts AS (
          SELECT date_trunc(${bucket}, hour AT TIME ZONE ${truncZone}) AS local_t,
                 sum(clicks + CASE WHEN ${includeBots} THEN bots ELSE 0 END)::int AS clicks
            FROM link_hours
           WHERE link_id = ${linkId} AND hour >= ${from} AND hour < ${to}
           GROUP BY 1
        )
        SELECT (b.local_t AT TIME ZONE ${truncZone}) AS t, coalesce(c.clicks, 0)::int AS clicks
          FROM buckets b LEFT JOIN counts c USING (local_t)
         ORDER BY 1`,
      db.$queryRaw<{ clicks: number; visitors: number; bots: number }[]>`
        SELECT coalesce(sum(clicks), 0)::int AS clicks, coalesce(sum(visitors), 0)::int AS visitors,
               coalesce(sum(bots), 0)::int AS bots
          FROM link_hours
         WHERE link_id = ${linkId} AND hour >= ${from} AND hour < ${to}`,
      db.$queryRaw<{ dimension: Dimension; key: string; clicks: number }[]>`
        SELECT dimension, key, clicks FROM (
          SELECT dimension, key, sum(clicks)::int AS clicks,
                 row_number() OVER (PARTITION BY dimension ORDER BY sum(clicks) DESC, key) AS rank
            FROM click_rollups
           WHERE link_id = ${linkId} AND hour >= ${from} AND hour < ${to} AND (NOT is_bot OR ${includeBots})
           GROUP BY dimension, key
        ) ranked
         WHERE rank <= ${BREAKDOWN_LIMIT}
         ORDER BY dimension, clicks DESC, key`,
      db.$queryRaw<{ dow: number; hod: number; clicks: number }[]>`
        SELECT (extract(isodow FROM hour AT TIME ZONE ${tz}) - 1)::int AS dow,
               extract(hour FROM hour AT TIME ZONE ${tz})::int AS hod,
               sum(clicks + CASE WHEN ${includeBots} THEN bots ELSE 0 END)::int AS clicks
          FROM link_hours
         WHERE link_id = ${linkId} AND hour >= ${from} AND hour < ${to}
         GROUP BY 1, 2`,
    ]).catch((error: unknown) => {
      // A zone ICU knows and Postgres does not (rare, but the two lists are
      // maintained separately) is the caller's input, not a server fault.
      if (String(error).includes('time zone')) {
        throw new DomainError('INVALID', `The database does not know the time zone “${tz}”.`, {
          field: 'tz',
        });
      }
      throw error;
    });

    const breakdowns = Object.fromEntries(
      DIMENSIONS.map((d) => [d, [] as BreakdownRow[]]),
    ) as Record<Dimension, BreakdownRow[]>;
    for (const row of breakdown)
      breakdowns[row.dimension].push({ key: row.key, clicks: row.clicks });

    const hourOfWeek = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const cell of week) hourOfWeek[cell.dow]![cell.hod] = cell.clicks;

    const total = totals[0] ?? { clicks: 0, visitors: 0, bots: 0 };
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      tz,
      bucket,
      totals: { clicks: total.clicks, visitors: total.visitors, bots: total.bots },
      series: series.map((s) => ({ t: s.t.toISOString(), clicks: s.clicks })),
      breakdowns,
      hourOfWeek,
    };
  }
}
