import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as constraints from './constraints';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

/** Every migration's SQL, concatenated. Read from disk, never a copy. */
const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'))
  .join('\n');

/** Strip SQL line comments so a name mentioned only in prose does not count. */
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const named = Object.entries(constraints)
  .filter(([key, value]) => typeof value === 'string' && /^[A-Z_]+$/u.test(key))
  .filter(([key]) => !key.startsWith('PRISMA_') && !key.startsWith('PG_'))
  .map(([key, value]) => [key, value as string] as const);

describe('every exported name exists in a migration', () => {
  // The failure this catches: a constraint renamed in the migration while the
  // catch block still matches the old name. Nothing errors -- the catch simply
  // stops firing, and a slug conflict that used to be a clean 409 becomes a 500.
  it('has a non-trivial number of them, so an empty export list cannot pass', () => {
    expect(named.length).toBeGreaterThan(15);
  });

  for (const [key, value] of named) {
    it(`${key} -> ${value}`, () => {
      expect(statements).toContain(`"${value}"`);
    });
  }
});

describe('every exported name is in exactly one group', () => {
  const groups = [
    constraints.CHECK_CONSTRAINTS,
    constraints.UNIQUE_INDEXES,
    constraints.INDEXES,
    constraints.RAW_TABLES,
    constraints.FUNCTIONS,
  ].flatMap((group) => Object.values(group));

  for (const [key, value] of named) {
    it(key, () => {
      expect(groups.filter((name) => name === value)).toHaveLength(1);
    });
  }
});

describe('the pipeline migration carries the rules the design depends on', () => {
  it.each([
    ['clicks is partitioned by time', 'PARTITION BY RANGE ("at")'],
    ['the stream entry id is the idempotency key', 'PRIMARY KEY ("id", "at")'],
    ['an insert for an uncovered month is kept, not refused', 'PARTITION OF "clicks" DEFAULT'],
    ['concurrent partition creation is serialised', 'pg_advisory_xact_lock'],
  ])('%s', (_rule, fragment) => {
    expect(statements).toContain(fragment);
  });

  it('stores no IP address anywhere', () => {
    // SPECS outcome 7. Held at runtime by the integration lane; held here at the
    // schema, so a column named ip or address cannot be added quietly.
    expect(statements).not.toMatch(/"(ip|ip_address|address|remote_addr)"/iu);
  });
});
