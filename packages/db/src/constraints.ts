/**
 * The names Postgres will use when it refuses a write.
 *
 * Catch blocks match on these, never on the message text. Postgres owns the
 * wording and changes it between minor versions; the constraint name is ours and
 * is set explicitly in the migration.
 *
 * Two vocabularies, because two clients report the same violation differently:
 * Prisma's typed client raises `PrismaClientKnownRequestError` with a `code` like
 * `P2002`, while `$queryRaw` surfaces the SQLSTATE (`23505`) instead.
 */

// --- Prisma's typed client -------------------------------------------------
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';

// --- SQLSTATE, as seen through $queryRaw -----------------------------------
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

// --- Constraint, index and function names, from the migrations --------------
export const USER_EMAIL_UNIQUE = 'users_email_key';
export const LINK_SLUG_UNIQUE = 'links_slug_key';

export const LINK_SLUG_SHAPE = 'links_slug_shape';
export const LINK_URL_SCHEME = 'links_url_scheme';
export const LINK_MAX_CLICKS_POSITIVE = 'links_max_clicks_positive';
export const LINK_HOURS_NON_NEGATIVE = 'link_hours_non_negative';
export const LINK_HOURS_ON_THE_HOUR = 'link_hours_on_the_hour';
export const CLICK_ROLLUPS_NON_NEGATIVE = 'click_rollups_non_negative';
export const CLICK_ROLLUPS_DIMENSION = 'click_rollups_dimension';
export const CLICKS_VISITOR_LENGTH = 'clicks_visitor_length';

export const LINKS_USER_CREATED_INDEX = 'links_user_created_idx';
export const CLICKS_LINK_AT_INDEX = 'clicks_link_at_idx';
export const VISITOR_HOURS_HOUR_INDEX = 'visitor_hours_hour_idx';

export const CLICKS_TABLE = 'clicks';
export const CLICKS_DEFAULT_PARTITION = 'clicks_default';
export const VISITOR_HOURS_TABLE = 'visitor_hours';
export const ENSURE_CLICK_PARTITIONS = 'ensure_click_partitions';

/**
 * The same names, grouped by what kind of object they are. Built from the
 * constants above; `constraints.test.ts` asserts every exported name is in a
 * migration, and `scripts/db-drift.mjs` checks each group against the catalog.
 */
export const CHECK_CONSTRAINTS = Object.freeze({
  LINK_SLUG_SHAPE,
  LINK_URL_SCHEME,
  LINK_MAX_CLICKS_POSITIVE,
  LINK_HOURS_NON_NEGATIVE,
  LINK_HOURS_ON_THE_HOUR,
  CLICK_ROLLUPS_NON_NEGATIVE,
  CLICK_ROLLUPS_DIMENSION,
  CLICKS_VISITOR_LENGTH,
});

export const UNIQUE_INDEXES = Object.freeze({ USER_EMAIL_UNIQUE, LINK_SLUG_UNIQUE });

/** Non-unique indexes whose absence is silent: a sequential scan, never an error. */
export const INDEXES = Object.freeze({
  LINKS_USER_CREATED_INDEX,
  CLICKS_LINK_AT_INDEX,
  VISITOR_HOURS_HOUR_INDEX,
});

/** Tables Prisma's datamodel does not describe, so its diff cannot see them. */
export const RAW_TABLES = Object.freeze({
  CLICKS_TABLE,
  CLICKS_DEFAULT_PARTITION,
  VISITOR_HOURS_TABLE,
});

export const FUNCTIONS = Object.freeze({ ENSURE_CLICK_PARTITIONS });

/**
 * The COLUMNS each unique index covers, as Postgres names them. The typed client
 * reports a unique violation's columns in `meta.target`, never the index name.
 */
export const UNIQUE_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [USER_EMAIL_UNIQUE]: Object.freeze(['email']),
  [LINK_SLUG_UNIQUE]: Object.freeze(['slug']),
});
