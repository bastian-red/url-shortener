#!/usr/bin/env node
/**
 * Prove the live database matches what the repository says it should be.
 *
 * Two checks, because neither one covers the other.
 *
 * **1. `prisma migrate diff` against the datamodel.** `prisma migrate status`
 * does NOT do this, and believing it does is how this project's database spent a
 * day carrying a schema no migration file described. Measured on 2026-08-26,
 * after `20260825120000_init/migration.sql` was edited to remove a generated
 * `search` column:
 *
 *     $ prisma migrate status
 *     2 migrations found in prisma/migrations
 *     Database schema is up to date!
 *
 *     $ psql -c '\d documents'
 *     search | tsvector | generated always as (...) stored
 *
 *     $ sha256sum .../20260825120000_init/migration.sql
 *     fe86c89f...                       # _prisma_migrations says fd3bb212...
 *
 * `migrate status` reads the LEDGER -- which migration names have a
 * `finished_at` -- and never compares a column. An already-applied migration
 * that is edited afterwards is invisible to it, including the checksum change.
 *
 * **2. The raw-SQL objects, by name.** The diff in check 1 is blind to
 * everything Prisma's datamodel cannot express, which in this project is the
 * entire `click_pipeline` migration: the CHECK constraints, the partitioned
 * `clicks` table and its default partition, the visitor sets and the partition
 * function. Prisma would report "no difference" against a database with none of
 * them. So they are asserted here by name, against
 * `packages/db/src/constraints.ts`.
 *
 *   node scripts/db-drift.mjs
 *
 * 0 = the database matches. 1 = drift, with the SQL that would close it.
 * 2 = the check could not run, which is not the same as a pass.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPackage = join(repoRoot, 'packages', 'db');

function fail(message, detail) {
  console.error(`db-drift: ${message}`);
  if (detail !== undefined) console.error(`\n${detail}\n`);
  process.exit(1);
}

function cannotRun(message, detail) {
  console.error(`db-drift: ${message}`);
  if (detail !== undefined) console.error(`\n${detail}\n`);
  process.exit(2);
}

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  cannotRun('DATABASE_URL is not set. Source .env first, or run this through pnpm db:drift.');
}

// --- 1. The datamodel diff -------------------------------------------------

let diffSql;
try {
  diffSql = execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      databaseUrl,
      // Relative to `cwd` below, which is packages/db.
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: dbPackage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  // Stderr is reported rather than discarded: a prisma that cannot reach the
  // database exits non-zero with the reason there, and swallowing it turns
  // "the check could not run" into "the check passed".
  cannotRun('prisma migrate diff failed to run.', `${error.stdout ?? ''}${error.stderr ?? ''}`);
}

// The raw tables (clicks, its partitions, visitor_hours) are invisible to the
// datamodel by design, so the diff proposes dropping them. Those statements are
// expected and removed; check 2 asserts the tables by name instead. Anything
// else Prisma wants to change is real drift.
const RAW_OBJECT = /"(clicks(_[a-z0-9]+)?|visitor_hours)"/u;
const meaningful = diffSql
  .split(/\n(?=-- )/u)
  .filter((block) => !RAW_OBJECT.test(block))
  .join('\n')
  .trim();
if (meaningful !== '' && !/this is an empty migration/iu.test(meaningful)) {
  fail(
    'the database does NOT match packages/db/prisma/schema.prisma. Prisma would need:',
    `${meaningful}\n\nReapply the migrations to a fresh database. Do not edit the schema to match the drift.`,
  );
}

// --- 2. The objects Prisma's datamodel cannot see --------------------------

const { PrismaClient } = await import(join(dbPackage, 'generated', 'client', 'index.js')).then(
  (module) => module.default ?? module,
);
const { CHECK_CONSTRAINTS, FUNCTIONS, INDEXES, RAW_TABLES, UNIQUE_INDEXES, CLICKS_TABLE } =
  await import(join(dbPackage, 'dist', 'index.js')).then((module) => module.default ?? module);

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
try {
  const constraints = await prisma.$queryRaw`
    SELECT conname FROM pg_constraint WHERE contype = 'c'
  `;
  const checks = new Set(constraints.map((row) => row.conname));
  const missingChecks = Object.values(CHECK_CONSTRAINTS).filter((name) => !checks.has(name));
  if (missingChecks.length > 0) {
    fail(
      `${missingChecks.length} CHECK constraint(s) from the click_pipeline migration are not in the database.`,
      missingChecks.join('\n'),
    );
  }

  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  `;
  const indexNames = new Set(indexes.map((row) => row.indexname));
  for (const name of [...Object.values(UNIQUE_INDEXES), ...Object.values(INDEXES)]) {
    if (!indexNames.has(name)) fail(`the ${name} index is not in the database.`);
  }

  const tables = await prisma.$queryRaw`
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `;
  const kinds = new Map(tables.map((row) => [row.relname, row.relkind]));
  for (const name of Object.values(RAW_TABLES)) {
    if (!kinds.has(name)) fail(`the ${name} table is not in the database.`);
  }
  // Partitioned, specifically. A plain `clicks` table would accept every insert
  // and quietly lose the property the monthly partitions exist for.
  if (kinds.get(CLICKS_TABLE) !== 'p')
    fail(`${CLICKS_TABLE} exists but is not a partitioned table.`);

  const functions = await prisma.$queryRaw`
    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  `;
  const fnNames = new Set(functions.map((row) => row.proname));
  for (const name of Object.values(FUNCTIONS)) {
    if (!fnNames.has(name)) fail(`the ${name}() function is not in the database.`);
  }

  // The current month must have its own partition: if it does not, every click
  // this month is landing in clicks_default, and creating the month's partition
  // later fails because the default already holds rows for its range.
  const current = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = '"clicks"'::regclass
       AND c.relname = 'clicks_' || to_char(now() AT TIME ZONE 'UTC', '"y"YYYY"m"MM')
  `;
  if (current[0].n !== 1) fail("this month's clicks partition does not exist.");

  console.log('db-drift: the database matches the schema, the CHECKs and the indexes.');
  console.log(
    'db-drift: clicks is partitioned, this month has its partition, visitor_hours and the partition function exist.',
  );
} finally {
  await prisma.$disconnect();
}
