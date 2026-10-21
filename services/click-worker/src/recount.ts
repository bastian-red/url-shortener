/**
 * The rollups, recomputed from the raw clicks, as a list of disagreements.
 *
 * SPECS outcome 6 says the rollup tables equal a full recount. This is the
 * recount: one query that rebuilds `link_hours` and `click_rollups` from
 * `clicks` and returns every row where the stored value differs (missing rows
 * on either side included). An empty result is the proof. It is run by the
 * worker's crash test, the API's scale test and `pnpm db:recount` (packages/db).
 *
 * Plain SQL with no parameters except an optional link filter, so both `pg`
 * and Prisma's `$queryRawUnsafe` can run it unchanged.
 */
export const ROLLUP_DRIFT_SQL = `
WITH hours AS (
  SELECT link_id, date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
         count(*) FILTER (WHERE NOT is_bot)::int AS clicks,
         count(*) FILTER (WHERE is_bot)::int AS bots,
         count(DISTINCT visitor) FILTER (WHERE NOT is_bot)::int AS visitors
    FROM clicks
   WHERE ($1::text IS NULL OR link_id = $1)
   GROUP BY 1, 2
), hour_drift AS (
  SELECT 'link_hours' AS "table", coalesce(h.link_id, s.link_id) AS link_id, coalesce(h.hour, s.hour) AS hour,
         NULL::text AS dimension, NULL::text AS key,
         coalesce(s.clicks, -1) AS stored, coalesce(h.clicks, -1) AS recounted,
         'clicks=' || coalesce(s.clicks, -1) || '/' || coalesce(h.clicks, -1) ||
         ' bots=' || coalesce(s.bots, -1) || '/' || coalesce(h.bots, -1) ||
         ' visitors=' || coalesce(s.visitors, -1) || '/' || coalesce(h.visitors, -1) AS detail
    FROM hours h
    FULL JOIN (SELECT * FROM link_hours WHERE ($1::text IS NULL OR link_id = $1)) s
      ON s.link_id = h.link_id AND s.hour = h.hour
   WHERE s.link_id IS NULL OR h.link_id IS NULL
      OR s.clicks <> h.clicks OR s.bots <> h.bots OR s.visitors <> h.visitors
), dims AS (
  SELECT c.link_id, date_trunc('hour', c.at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour, c.is_bot, d.dimension, d.key,
         count(*)::int AS clicks
    FROM clicks c
   CROSS JOIN LATERAL (VALUES ('country', c.country), ('device', c.device), ('browser', c.browser),
                              ('os', c.os), ('referrer', c.referrer)) AS d(dimension, key)
   WHERE ($1::text IS NULL OR c.link_id = $1)
   GROUP BY 1, 2, 3, 4, 5
), dim_drift AS (
  SELECT 'click_rollups', coalesce(d.link_id, r.link_id), coalesce(d.hour, r.hour),
         coalesce(d.dimension, r.dimension), coalesce(d.key, r.key),
         coalesce(r.clicks, -1), coalesce(d.clicks, -1),
         'is_bot=' || coalesce(d.is_bot, r.is_bot)
    FROM dims d
    FULL JOIN (SELECT * FROM click_rollups WHERE ($1::text IS NULL OR link_id = $1)) r
      ON r.link_id = d.link_id AND r.hour = d.hour AND r.is_bot = d.is_bot
     AND r.dimension = d.dimension AND r.key = d.key
   WHERE r.link_id IS NULL OR d.link_id IS NULL OR r.clicks <> d.clicks
)
SELECT * FROM hour_drift
UNION ALL
SELECT * FROM dim_drift
ORDER BY 1, 2, 3
LIMIT 50`;

export interface RollupDrift {
  table: 'link_hours' | 'click_rollups';
  link_id: string;
  hour: Date;
  dimension: string | null;
  key: string | null;
  stored: number;
  recounted: number;
  detail: string;
}
