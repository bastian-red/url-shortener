import type { PoolClient } from 'pg';

import { aggregate, type HourDelta } from './aggregate';
import type { EnrichedClick } from './enrich';

/**
 * Writing one batch: raw clicks, visitor sets and both rollup tables, in ONE
 * transaction.
 *
 * One transaction is what makes the rollups trustworthy. If the raw insert
 * committed and the rollup upsert did not, the report would silently disagree
 * with the log forever; if the rollups committed and the raw insert did not,
 * a redelivery would count the batch twice.
 *
 * And the raw insert's `ON CONFLICT DO NOTHING RETURNING id` is what makes a
 * redelivery harmless: only rows that actually went in are aggregated, so an
 * entry processed twice (committed, then the worker died before XACK) adds
 * nothing the second time.
 */

export interface WriteResult {
  /** Clicks inserted by this call: what was not already stored. */
  inserted: EnrichedClick[];
  /** Entries whose link no longer exists (its owner's account was deleted). */
  orphaned: number;
  duplicates: number;
}

export async function writeBatch(
  client: PoolClient,
  clicks: readonly EnrichedClick[],
): Promise<WriteResult> {
  if (clicks.length === 0) return { inserted: [], orphaned: 0, duplicates: 0 };

  await client.query('BEGIN');
  try {
    // The EXISTS filter: a click for a link that was hard-deleted (account
    // deletion cascades) would violate the foreign key and abort the WHOLE
    // batch, wedging the stream on one entry. It is dropped instead.
    const raw = await client.query<{ id: string }>(
      `INSERT INTO clicks (id, at, link_id, country, region, city, device, browser, os, referrer, visitor, is_bot)
       SELECT u.* FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[],
                             $7::text[], $8::text[], $9::text[], $10::text[], $11::bytea[], $12::bool[])
              AS u(id, at, link_id, country, region, city, device, browser, os, referrer, visitor, is_bot)
        WHERE EXISTS (SELECT 1 FROM links l WHERE l.id = u.link_id)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        clicks.map((c) => c.id),
        clicks.map((c) => c.at),
        clicks.map((c) => c.linkId),
        clicks.map((c) => c.country),
        clicks.map((c) => c.region),
        clicks.map((c) => c.city),
        clicks.map((c) => c.device),
        clicks.map((c) => c.browser),
        clicks.map((c) => c.os),
        clicks.map((c) => c.referrer),
        clicks.map((c) => c.visitor),
        clicks.map((c) => c.isBot),
      ],
    );
    const insertedIds = new Set(raw.rows.map((row) => row.id));
    const inserted = clicks.filter((c) => insertedIds.has(c.id));

    const known = await client.query<{ id: string }>(
      'SELECT id FROM links WHERE id = ANY($1::text[])',
      [[...new Set(clicks.map((c) => c.linkId))]],
    );
    const live = new Set(known.rows.map((row) => row.id));
    const orphaned = clicks.filter((c) => !live.has(c.linkId)).length;

    if (inserted.length > 0) {
      const newVisitors = await countNewVisitors(client, inserted);
      const { hours, rollups } = aggregate(inserted);
      await upsertHours(client, hours, newVisitors);
      await client.query(
        `INSERT INTO click_rollups (link_id, hour, is_bot, dimension, key, clicks)
         SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::bool[], $4::text[], $5::text[], $6::int[])
         ON CONFLICT (link_id, hour, is_bot, dimension, key)
         DO UPDATE SET clicks = click_rollups.clicks + EXCLUDED.clicks`,
        [
          rollups.map((r) => r.linkId),
          rollups.map((r) => r.hour),
          rollups.map((r) => r.isBot),
          rollups.map((r) => r.dimension),
          rollups.map((r) => r.key),
          rollups.map((r) => r.clicks),
        ],
      );
    }

    await client.query('COMMIT');
    return { inserted, orphaned, duplicates: clicks.length - inserted.length - orphaned };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** (link, hour) -> visitors first seen in this batch. Humans only. */
async function countNewVisitors(
  client: PoolClient,
  inserted: readonly EnrichedClick[],
): Promise<Map<string, number>> {
  const humans = inserted.filter((c) => !c.isBot);
  const counts = new Map<string, number>();
  if (humans.length === 0) return counts;
  // Sorted for the same lock-order reason as the rollups.
  const sorted = [...humans].sort((a, b) =>
    keyOf(a.linkId, a.hour).localeCompare(keyOf(b.linkId, b.hour)),
  );
  const result = await client.query<{ link_id: string; hour: Date }>(
    `INSERT INTO visitor_hours (link_id, hour, visitor)
     SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::bytea[])
     ON CONFLICT DO NOTHING
     RETURNING link_id, hour`,
    [sorted.map((c) => c.linkId), sorted.map((c) => c.hour), sorted.map((c) => c.visitor)],
  );
  for (const row of result.rows) {
    const key = keyOf(row.link_id, row.hour);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function upsertHours(
  client: PoolClient,
  hours: readonly HourDelta[],
  visitors: Map<string, number>,
): Promise<void> {
  await client.query(
    `INSERT INTO link_hours (link_id, hour, clicks, bots, visitors)
     SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::int[], $4::int[], $5::int[])
     ON CONFLICT (link_id, hour) DO UPDATE SET
       clicks = link_hours.clicks + EXCLUDED.clicks,
       bots = link_hours.bots + EXCLUDED.bots,
       visitors = link_hours.visitors + EXCLUDED.visitors`,
    [
      hours.map((h) => h.linkId),
      hours.map((h) => h.hour),
      hours.map((h) => h.clicks),
      hours.map((h) => h.bots),
      hours.map((h) => visitors.get(keyOf(h.linkId, h.hour)) ?? 0),
    ],
  );
}

function keyOf(linkId: string, hour: Date): string {
  return `${linkId}|${hour.toISOString()}`;
}

/** Keep the monthly partitions ahead of the clock. Idempotent. */
export async function ensurePartitions(client: PoolClient, now: Date): Promise<number> {
  const result = await client.query<{ created: number }>(
    `SELECT ensure_click_partitions($1::timestamptz - INTERVAL '1 day', $1::timestamptz + INTERVAL '2 months') AS created`,
    [now],
  );
  return result.rows[0]?.created ?? 0;
}

/**
 * Drop visitor sets nobody can add to any more. 48 hours, not 1: a backlog
 * (the worker down overnight) delivers old hours late, and a pruned set would
 * count those visitors a second time.
 */
export async function pruneVisitorSets(client: PoolClient, now: Date): Promise<number> {
  const result = await client.query(
    `DELETE FROM visitor_hours WHERE hour < $1::timestamptz - INTERVAL '48 hours'`,
    [now],
  );
  return result.rowCount ?? 0;
}
