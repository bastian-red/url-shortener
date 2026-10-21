/**
 * `pnpm db:recount`: rebuild the rollups from the raw clicks in memory and
 * report every disagreement with the stored ones. Exit 0 means the rollup
 * tables equal a full recount (SPECS outcome 6); exit 1 prints the drift.
 */
import pg from 'pg';

import { ROLLUP_DRIFT_SQL, type RollupDrift } from '@links/click-worker';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const [{ rows: drift }, { rows: totals }] = await Promise.all([
    client.query<RollupDrift>(ROLLUP_DRIFT_SQL, [process.argv[2] ?? null]),
    client.query<{ clicks: string; rollup_hours: string }>(
      'SELECT (SELECT count(*) FROM clicks) AS clicks, (SELECT count(*) FROM link_hours) AS rollup_hours',
    ),
  ]);
  if (drift.length > 0) {
    console.error(`recount: ${String(drift.length)} disagreement(s) between the rollups and the raw clicks:`);
    for (const d of drift) {
      console.error(`  ${d.table} ${d.link_id} ${d.hour.toISOString()} ${d.dimension ?? ''} ${d.key ?? ''} ${d.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`recount: rollups match the raw log (${totals[0]?.clicks ?? '?'} clicks, ${totals[0]?.rollup_hours ?? '?'} link-hours).`);
  }
} finally {
  await client.end();
}
