-- Everything Prisma's datamodel cannot express: the CHECK constraints, the
-- partitioned raw clicks table, the visitor set and the partition function.
--
-- Every object is NAMED, and the names are exported from src/constraints.ts so
-- catch blocks and scripts/db-drift.mjs match on a name, never on message text.

-- --- links -------------------------------------------------------------------

-- The same grammar as SLUG_PATTERN in @links/shared. The API checks first and
-- answers with a sentence; this is the backstop for a write that skipped it.
ALTER TABLE "links" ADD CONSTRAINT "links_slug_shape"
  CHECK ("slug" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$');

-- A destination the redirect service would put in a Location header. The API's
-- checkDestination is the real rule; this keeps a `javascript:` URL out even if
-- a future code path forgets to call it.
ALTER TABLE "links" ADD CONSTRAINT "links_url_scheme"
  CHECK ("url" ~ '^https?://' AND length("url") <= 2048);

ALTER TABLE "links" ADD CONSTRAINT "links_max_clicks_positive"
  CHECK ("max_clicks" IS NULL OR "max_clicks" > 0);

-- --- rollups -------------------------------------------------------------------

-- Only ever incremented, so a negative is a bug somewhere upstream. Postgres
-- evaluates a CHECK against the row an upsert PROPOSES, before ON CONFLICT
-- resolves it, which is why the worker never upserts a negative delta.
ALTER TABLE "link_hours" ADD CONSTRAINT "link_hours_non_negative"
  CHECK ("clicks" >= 0 AND "bots" >= 0 AND "visitors" >= 0 AND "visitors" <= "clicks");

ALTER TABLE "link_hours" ADD CONSTRAINT "link_hours_on_the_hour"
  CHECK ("hour" = date_trunc('hour', "hour" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

ALTER TABLE "click_rollups" ADD CONSTRAINT "click_rollups_non_negative"
  CHECK ("clicks" >= 0);

ALTER TABLE "click_rollups" ADD CONSTRAINT "click_rollups_dimension"
  CHECK ("dimension" IN ('country', 'device', 'browser', 'os', 'referrer'));

-- --- clicks: the raw log, range-partitioned by month -------------------------
--
-- `id` is the Redis Stream entry id ("1792584000000-0"). It is the idempotency
-- key: a worker that crashes after committing but before XACK gets the entry
-- redelivered, and ON CONFLICT DO NOTHING turns the second insert into nothing.
-- A partitioned table's primary key must include the partition key, so the key
-- is (id, at); `at` is derived from the event's own timestamp, so a redelivered
-- entry carries the same `at` and lands on the same key.
--
-- There is no IP column, and that is the point. The worker turns the address
-- into a country and a salted visitor hash and then forgets it.

CREATE TABLE "clicks" (
  "id"       TEXT           NOT NULL,
  "at"       TIMESTAMPTZ(3) NOT NULL,
  "link_id"  TEXT           NOT NULL,
  "country"  TEXT           NOT NULL DEFAULT '',
  "region"   TEXT           NOT NULL DEFAULT '',
  "city"     TEXT           NOT NULL DEFAULT '',
  "device"   TEXT           NOT NULL,
  "browser"  TEXT           NOT NULL,
  "os"       TEXT           NOT NULL,
  "referrer" TEXT           NOT NULL,
  -- HMAC-SHA256(daily key, ip | user agent), first 16 bytes. Rotates daily, so
  -- it cannot follow a person across days, and without the key it cannot be
  -- reversed to an address by enumerating the IPv4 space.
  "visitor"  BYTEA          NOT NULL,
  "is_bot"   BOOLEAN        NOT NULL,
  CONSTRAINT "clicks_pkey" PRIMARY KEY ("id", "at"),
  CONSTRAINT "clicks_visitor_length" CHECK (octet_length("visitor") = 16),
  CONSTRAINT "clicks_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "links"("id") ON DELETE CASCADE
) PARTITION BY RANGE ("at");

CREATE INDEX "clicks_link_at_idx" ON "clicks" ("link_id", "at");

-- Catch-all, so an insert for a month nobody created a partition for is stored
-- rather than refused. ensure_click_partitions keeps it empty in practice: a
-- default partition holding rows for a range blocks creating that range's
-- partition later.
CREATE TABLE "clicks_default" PARTITION OF "clicks" DEFAULT;

-- Create the monthly partitions covering [p_from, p_to]. Idempotent, and safe to
-- call from several workers at once: CREATE TABLE IF NOT EXISTS is not atomic
-- against a concurrent identical CREATE (both can pass the existence check and
-- one then fails on the catalog's unique index), so the whole body runs under a
-- transaction-scoped advisory lock.
CREATE FUNCTION "ensure_click_partitions"(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  month_start TIMESTAMPTZ := date_trunc('month', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  last_month  TIMESTAMPTZ := date_trunc('month', p_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  part_name   TEXT;
  created     INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ensure_click_partitions'));
  WHILE month_start <= last_month LOOP
    part_name := 'clicks_' || to_char(month_start AT TIME ZONE 'UTC', '"y"YYYY"m"MM');
    IF to_regclass(format('%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF "clicks" FOR VALUES FROM (%L) TO (%L)',
        part_name,
        month_start,
        (month_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC'
      );
      created := created + 1;
    END IF;
    month_start := (month_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC';
  END LOOP;
  RETURN created;
END;
$$;

-- Three months back (the analytics window) and two ahead, at migration time.
-- The worker calls the function again at boot and daily, so the ahead-window
-- keeps moving without a migration.
SELECT "ensure_click_partitions"(now() - INTERVAL '3 months', now() + INTERVAL '2 months');

-- --- visitor_hours: the distinct-visitor sets --------------------------------
--
-- link_hours.visitors is "distinct visitors in this hour". Incrementing it needs
-- to know whether this visitor was already seen in this hour, which is this
-- table: the worker inserts (link, hour, visitor) ON CONFLICT DO NOTHING and
-- counts only the rows that went in. An hour's set is only needed while events
-- for that hour can still arrive, so the worker prunes sets older than 48 hours.

CREATE TABLE "visitor_hours" (
  "link_id" TEXT           NOT NULL,
  "hour"    TIMESTAMPTZ(3) NOT NULL,
  "visitor" BYTEA          NOT NULL,
  CONSTRAINT "visitor_hours_pkey" PRIMARY KEY ("link_id", "hour", "visitor"),
  CONSTRAINT "visitor_hours_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "links"("id") ON DELETE CASCADE
);

CREATE INDEX "visitor_hours_hour_idx" ON "visitor_hours" ("hour");
