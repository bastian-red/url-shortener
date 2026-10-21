import { describe, expect, it } from 'vitest';

import {
  LINK_SLUG_UNIQUE,
  PG_CHECK_VIOLATION,
  PG_UNIQUE_VIOLATION,
  PRISMA_FOREIGN_KEY_VIOLATION,
  PRISMA_UNIQUE_VIOLATION,
  UNIQUE_INDEXES,
  UNIQUE_INDEX_COLUMNS,
  USER_EMAIL_UNIQUE,
} from './constraints';
import {
  isCheckViolation,
  isNotFound,
  isUniqueViolation,
  violatedConstraint,
  violatedUniqueIndex,
} from './errors';

/** What the typed client raises for a unique violation. */
const typed = (code: string, target: string[]) => ({ code, meta: { target }, message: 'ignored' });

/**
 * What a $queryRaw violation looks like: PrismaClientUnknownRequestError, whose
 * `code` is undefined and whose SQLSTATE is only inside the message text. This
 * is the shape project004's predicates missed, turning every conflict into a 500
 * while the unit tests passed against a fixture no client ever produces.
 */
const raw = (sqlstate: string, detail: string) => ({
  name: 'PrismaClientUnknownRequestError',
  code: undefined,
  message: `Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${sqlstate}\`. Message: \`${detail}\``,
});

describe('isUniqueViolation', () => {
  it('recognises the typed client', () => {
    expect(isUniqueViolation(typed('P2002', ['token']))).toBe(true);
  });

  it('recognises the raw SQLSTATE, both as a code and inside a message', () => {
    expect(isUniqueViolation({ code: PG_UNIQUE_VIOLATION })).toBe(true);
    expect(isUniqueViolation(raw(PG_UNIQUE_VIOLATION, 'duplicate key value'))).toBe(true);
  });

  it('says no to anything else, including a bare object and null', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(typed('P2003', ['x']))).toBe(false);
  });
});

describe('isCheckViolation', () => {
  it('recognises a CHECK failure through either vocabulary', () => {
    expect(isCheckViolation({ code: PG_CHECK_VIOLATION })).toBe(true);
    expect(isCheckViolation(raw(PG_CHECK_VIOLATION, 'violates check constraint'))).toBe(true);
    expect(isCheckViolation(typed('P2002', ['x']))).toBe(false);
  });
});

describe('violatedConstraint', () => {
  it('reads meta.target as an array, which is where the typed client puts it', () => {
    expect(violatedConstraint(typed('P2002', [LINK_SLUG_UNIQUE]), LINK_SLUG_UNIQUE)).toBe(true);
  });

  it('reads meta.constraint, which is where a raw violation puts it', () => {
    expect(violatedConstraint({ meta: { constraint: LINK_SLUG_UNIQUE } }, LINK_SLUG_UNIQUE)).toBe(
      true,
    );
  });

  it('falls back to the message, which is the only place a raw error names it', () => {
    expect(
      violatedConstraint(
        raw(
          PG_UNIQUE_VIOLATION,
          `duplicate key value violates unique constraint "${LINK_SLUG_UNIQUE}"`,
        ),
        LINK_SLUG_UNIQUE,
      ),
    ).toBe(true);
  });

  it('does not match a different constraint', () => {
    expect(violatedConstraint(typed('P2002', ['users_email_key']), LINK_SLUG_UNIQUE)).toBe(false);
    expect(violatedConstraint(null, LINK_SLUG_UNIQUE)).toBe(false);
  });
});

describe('isNotFound', () => {
  it('is P2025 and nothing else', () => {
    expect(isNotFound({ code: 'P2025' })).toBe(true);
    expect(isNotFound({ code: 'P2002' })).toBe(false);
  });
});

/**
 * `violatedUniqueIndex`, against BOTH shapes a violation actually arrives in.
 *
 * The two shapes below are the ones `@prisma/client@5` produces: the typed
 * client reports columns in `meta.target` and never the index name, `$queryRaw`
 * reports the name only in the message. The integration lane provokes a real
 * duplicate slug through the API and asserts the 409, which is what proves these
 * shapes are the real ones rather than remembered ones.
 */
describe('violatedUniqueIndex', () => {
  /** What the typed client raises: a `code`, columns in `meta.target`, no index name anywhere. */
  function typedClient(columns: readonly string[]): unknown {
    return {
      code: PRISMA_UNIQUE_VIOLATION,
      meta: { modelName: 'User', target: [...columns] },
      message: `Unique constraint failed on the fields: (\`${columns.join('`,`')}\`)`,
    };
  }

  /** What `$queryRaw` raises: no `code`, no `meta`, the SQLSTATE and the name in the text. */
  function rawQuery(name: string): unknown {
    return {
      message: `${PG_UNIQUE_VIOLATION} duplicate key value violates unique constraint "${name}"`,
    };
  }

  it.each(Object.values(UNIQUE_INDEXES))('matches %s through the typed client', (name) => {
    expect(violatedUniqueIndex(typedClient(UNIQUE_INDEX_COLUMNS[name]!), name)).toBe(true);
  });

  it.each(Object.values(UNIQUE_INDEXES))('matches %s through a raw query', (name) => {
    expect(violatedUniqueIndex(rawQuery(name), name)).toBe(true);
  });

  /**
   * The regression that motivated the whole function. `users_email_key` never
   * appears in a typed-client error, so the name-only predicate is false and the
   * duplicate sign-up becomes a 500.
   */
  it('is what a name-only check gets wrong', () => {
    const error = typedClient(['email']);
    expect(violatedConstraint(error, USER_EMAIL_UNIQUE)).toBe(false);
    expect(violatedUniqueIndex(error, USER_EMAIL_UNIQUE)).toBe(true);
  });

  it('does not match a different index, or a superset of its columns', () => {
    // A subset or an overlap must not count as a match, or every unique
    // violation would look like every other one.
    expect(violatedUniqueIndex(typedClient(['slug']), USER_EMAIL_UNIQUE)).toBe(false);
    expect(violatedUniqueIndex(typedClient(['email']), LINK_SLUG_UNIQUE)).toBe(false);
    expect(violatedUniqueIndex(typedClient(['slug', 'user_id']), LINK_SLUG_UNIQUE)).toBe(false);
  });

  it('refuses an error that is not a unique violation at all', () => {
    expect(
      violatedUniqueIndex(
        { code: PRISMA_FOREIGN_KEY_VIOLATION, meta: { target: ['email'] } },
        USER_EMAIL_UNIQUE,
      ),
    ).toBe(false);
    expect(violatedUniqueIndex(new Error('connect ECONNREFUSED'), USER_EMAIL_UNIQUE)).toBe(false);
    expect(violatedUniqueIndex(null, USER_EMAIL_UNIQUE)).toBe(false);
  });

  it('answers false for a name it has no columns for, rather than guessing', () => {
    expect(violatedUniqueIndex(typedClient(['email']), 'some_index_nobody_declared')).toBe(false);
  });

  it('has a column list for every unique index, and for nothing else', () => {
    // A new unique index added to the group without its columns would make the
    // typed-client half of the predicate silently false for it.
    expect(Object.keys(UNIQUE_INDEX_COLUMNS).sort()).toEqual(Object.values(UNIQUE_INDEXES).sort());
  });
});
