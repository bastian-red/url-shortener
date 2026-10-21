/**
 * SPECS outcome 6: a report at 1,000,000 clicks stays under 150 ms at p95, and
 * the rollups it reads equal a full recount of the raw log.
 *
 * The million clicks are generated IN Postgres (generate_series), then rolled up
 * with the same grouping the worker's writer applies, because pushing a million
 * rows through the stream would take this lane ten minutes and prove nothing
 * the worker's own tests do not. What this file measures is the READ path at
 * volume, uncached: `compute()` is called directly, bypassing the closed-range
 * cache, 40 times.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLLUP_DRIFT_SQL, type RollupDrift } from '@links/click-worker';

import { AnalyticsService } from '../src/analytics/analytics.service';
import { boot, newAuthor, type Harness } from './support';
import type { SessionUser } from '@links/shared';

const CLICKS = 1_000_000;
const P95_BUDGET_MS = 150;
const RUNS = 40;

let harness: Harness;
let owner: SessionUser;
let linkId: string;
let analytics: AnalyticsService;

const HOUR = 3_600_000;
const to = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const from = new Date(to.getTime() - 30 * 24 * HOUR);

beforeAll(async () => {
  harness = await boot();
  owner = await newAuthor(harness.db, 'scale');
  const link = await harness.db.link.create({
    data: {
      userId: owner.id,
      slug: `scale${String(Date.now()).slice(-9)}`,
      url: 'https://example.com/scale',
    },
  });
  linkId = link.id;
  analytics = harness.app.get(AnalyticsService);

  const started = Date.now();
  // Raw clicks: realistic cardinalities (16 countries, 4 devices, 6 browsers,
  // 5 OSes, 9 referrers), timestamps spread over 30 days, 4% bots.
  await harness.db.$executeRaw`
    INSERT INTO clicks (id, at, link_id, country, device, browser, os, referrer, visitor, is_bot)
    SELECT 'scale-' || g || '-0',
           ${from}::timestamptz + (random() * INTERVAL '30 days'),
           ${linkId},
           (ARRAY['US','GB','DE','CL','IN','BR','FR','CA','ES','MX','JP','AU','NL','SE','AR',''])[1 + (g % 16)],
           CASE WHEN g % 25 = 0 THEN 'bot' ELSE (ARRAY['mobile','mobile','desktop','tablet'])[1 + (g % 4)] END,
           (ARRAY['Chrome','Mobile Safari','Safari','Firefox','Edge','Samsung Internet'])[1 + (g % 6)],
           (ARRAY['iOS','Android','Windows','Mac OS','Linux'])[1 + (g % 5)],
           (ARRAY['','t.co','linkedin.com','news.ycombinator.com','google.com','slack.com','reddit.com','bsky.app','github.com'])[1 + (g % 9)],
           substring(decode(md5((g % 300000)::text), 'hex') FROM 1 FOR 16),
           g % 25 = 0
      FROM generate_series(1, ${CLICKS}) AS g`;
  // Rollups with the worker's grouping.
  await harness.db.$executeRaw`
    INSERT INTO link_hours (link_id, hour, clicks, bots, visitors)
    SELECT link_id, date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
           count(*) FILTER (WHERE NOT is_bot), count(*) FILTER (WHERE is_bot),
           count(DISTINCT visitor) FILTER (WHERE NOT is_bot)
      FROM clicks WHERE link_id = ${linkId} GROUP BY 1, 2`;
  await harness.db.$executeRaw`
    INSERT INTO click_rollups (link_id, hour, is_bot, dimension, key, clicks)
    SELECT c.link_id, date_trunc('hour', c.at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', c.is_bot, d.dimension, d.key, count(*)
      FROM clicks c
     CROSS JOIN LATERAL (VALUES ('country', c.country), ('device', c.device), ('browser', c.browser),
                                ('os', c.os), ('referrer', c.referrer)) AS d(dimension, key)
     WHERE c.link_id = ${linkId}
     GROUP BY 1, 2, 3, 4, 5`;
  const rollupRows = await harness.db.$queryRaw<{ hours: number; dims: number }[]>`
    SELECT (SELECT count(*) FROM link_hours WHERE link_id = ${linkId})::int AS hours,
           (SELECT count(*) FROM click_rollups WHERE link_id = ${linkId})::int AS dims`;
  console.log(
    `[scale] a report reads ${String(rollupRows[0]!.hours)} link-hours and ${String(rollupRows[0]!.dims)} rollup rows, not ${String(CLICKS)} clicks`,
  );
  await harness.db.$executeRawUnsafe('ANALYZE link_hours');
  await harness.db.$executeRawUnsafe('ANALYZE click_rollups');
  console.log(
    `[scale] generated ${String(CLICKS)} clicks and their rollups in ${String(Date.now() - started)} ms`,
  );
}, 300_000);

afterAll(async () => {
  // Cascades to the million clicks and both rollup tables.
  await harness.db.user.delete({ where: { id: owner.id } });
  await harness.close();
}, 120_000);

describe(`a report over ${String(CLICKS)} clicks`, () => {
  it(`answers in under ${String(P95_BUDGET_MS)} ms at p95, uncached, day and hour buckets`, async () => {
    const timings: number[] = [];
    let total = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now();
      const report = await analytics.compute(
        linkId,
        from,
        to,
        i % 2 === 0 ? 'UTC' : 'Europe/Berlin',
        false,
      );
      timings.push(performance.now() - started);
      total = report.totals.clicks + report.totals.bots;
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(RUNS * 0.5)]!;
    const p95 = timings[Math.ceil(RUNS * 0.95) - 1]!;
    console.log(
      `[scale] ${String(RUNS)} reports: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${timings[RUNS - 1]!.toFixed(1)} ms`,
    );
    expect(total).toBe(CLICKS);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('reads rollups that equal a full recount of the raw log', async () => {
    const drift = await harness.db.$queryRawUnsafe<RollupDrift[]>(ROLLUP_DRIFT_SQL, linkId);
    expect(drift).toEqual([]);
  }, 120_000);
});
