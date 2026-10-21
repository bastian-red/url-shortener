#!/usr/bin/env node
/**
 * The work behind scripts/seed-check.sh (read its header for the three
 * properties). Node and `pg` rather than psql, so it runs wherever the repo's
 * dependencies are installed, with nothing extra on the machine.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'services', 'click-worker', 'package.json'));
const { Client } = require('pg');
const { ROLLUP_DRIFT_SQL } = require(join(ROOT, 'services', 'click-worker', 'dist', 'index.js'));

const SEED = readFileSync(join(ROOT, 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');
const DEMO_EMAIL = /^const DEMO_EMAIL = '([^']+)';/mu.exec(SEED)?.[1];
// The click counts the seed declares, read out of it rather than retyped.
const DECLARED = [...SEED.matchAll(/^\s+clicks: ([\d_]+),$/gmu)].reduce(
  (sum, m) => sum + Number(m[1].replace(/_/gu, '')),
  0,
);
if (!DEMO_EMAIL || DECLARED === 0) {
  console.error(
    'seed-check: could not read DEMO_EMAIL or the declared click counts out of seed.mts.',
  );
  process.exit(2);
}

const DIGEST_SQL = `
WITH demo AS (
  SELECT l.*, u.created_at AS anchor FROM links l JOIN users u ON u.id = l.user_id WHERE u.email = $1
), x AS (
  SELECT 'link ' || slug || ' ' || url || ' ' || coalesce(title, '-') || ' ' || disabled || ' ' ||
         coalesce(max_clicks::text, '-') || ' ' || coalesce(extract(epoch FROM expires_at - anchor)::text, '-') AS x
    FROM demo
  UNION ALL
  SELECT 'click ' || d.slug || ' ' || extract(epoch FROM c.at - d.anchor)::text || ' ' || c.country || ' ' ||
         c.device || ' ' || c.browser || ' ' || c.os || ' ' || c.referrer || ' ' || c.is_bot
    FROM clicks c JOIN demo d ON d.id = c.link_id
)
SELECT count(*)::int AS n, md5(string_agg(x, '|' ORDER BY x)) AS digest FROM x`;

function seed() {
  execFileSync('pnpm', ['--filter', '@links/db', 'exec', 'tsx', 'prisma/seed.mts'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const digest = async () => (await client.query(DIGEST_SQL, [DEMO_EMAIL])).rows[0];

  console.log('seed-check: first run');
  seed();
  const first = await digest();
  console.log(`  ${first.n} rows ${first.digest}`);

  console.log('seed-check: second run');
  seed();
  const second = await digest();
  console.log(`  ${second.n} rows ${second.digest}`);

  let failed = false;
  if (first.digest !== second.digest || first.n !== second.n) {
    console.error('FAIL: the seed is not deterministic or not idempotent.');
    console.error('A changed row count means the teardown left rows behind; the same count with a');
    console.error('changed digest means the generator read the clock or Math.random.');
    failed = true;
  }
  const { rows: totals } = await client.query(
    `SELECT count(*)::int AS n FROM clicks c JOIN links l ON l.id = c.link_id JOIN users u ON u.id = l.user_id WHERE u.email = $1`,
    [DEMO_EMAIL],
  );
  if (totals[0].n !== DECLARED) {
    console.error(`FAIL: ${totals[0].n} demo clicks stored, the seed declares ${DECLARED}.`);
    failed = true;
  }
  const { rows: drift } = await client.query(ROLLUP_DRIFT_SQL, [null]);
  if (drift.length > 0) {
    console.error(`FAIL: ${drift.length} rollup row(s) disagree with a recount of the raw clicks:`);
    for (const d of drift.slice(0, 10))
      console.error(`  ${d.table} ${d.link_id} ${d.dimension ?? ''} ${d.key ?? ''} ${d.detail}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(
    `PASS: two runs, identical digest over ${first.n} rows; ${DECLARED} clicks as declared; rollups equal a recount.`,
  );
} finally {
  await client.end();
}
