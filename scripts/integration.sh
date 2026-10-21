#!/usr/bin/env bash
#
# The integration lane: three processes and two datastores, for real.
#
#   ./scripts/integration.sh              # everything
#   ./scripts/integration.sh links        # only the API suite files matching "links"
#
# Order, and why:
#
#   1. Its own database (links_it) and its own Redis database (index 1), so it
#      never touches the data `pnpm dev` is using, and the crash test may empty
#      the clicks stream without eating a developer's unprocessed clicks.
#   2. Migrations, the drift check, the seed.
#   3. The Go cache tests (the Lua script's atomicity, against real Redis).
#   4. The worker crash test, BEFORE any long-running worker exists: it starts
#      and SIGKILLs its own.
#   5. The redirect service and a worker, started from their built artefacts
#      exactly as compose would, then the API suite against them.
#
# Every budget is the DOCUMENTED one from .env.example. Nothing is lifted: the
# suites spread anonymous calls over random addresses and signed-in calls over
# fresh users, which is how real traffic is keyed, and a lane that raises a
# limit hides that limit's bugs.
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

BASE_DB_URL="${DATABASE_URL:-postgresql://links:links@localhost:5442/links?schema=public}"
export DATABASE_URL="${INTEGRATION_DATABASE_URL:-${BASE_DB_URL/\/links\?/\/links_it?}}"
export DIRECT_DATABASE_URL="$DATABASE_URL"
BASE_REDIS_URL="${REDIS_URL:-redis://localhost:6388}"
export REDIS_URL="${INTEGRATION_REDIS_URL:-${BASE_REDIS_URL%/}/1}"
export AUTH_SECRET="${AUTH_SECRET:-integration-auth-secret-0123456789}"
export VISITOR_HASH_SECRET="${VISITOR_HASH_SECRET:-integration-visitor-secret-0123}"
[[ -n "$AUTH_SECRET" ]] || export AUTH_SECRET=integration-auth-secret-0123456789
[[ -n "$VISITOR_HASH_SECRET" ]] || export VISITOR_HASH_SECRET=integration-visitor-secret-0123

LOG_DIR="${LOG_DIR:-/tmp/shortener-integration}"
mkdir -p "$LOG_DIR"
REDIRECT_PORT_IT="${REDIRECT_PORT_IT:-18080}"
WORKER_PORT_IT="${WORKER_PORT_IT:-14100}"
export SHORT_BASE_URL="http://localhost:${REDIRECT_PORT_IT}"
export REDIRECT_INTERNAL_URL="$SHORT_BASE_URL"
export WORKER_INTERNAL_URL="http://localhost:${WORKER_PORT_IT}"
export REDIRECT_TEST_URL="$SHORT_BASE_URL"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do
    kill -- -"$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "integration: build"
pnpm exec turbo run build --output-logs=errors-only >/dev/null
./scripts/geo-db.sh --test >/dev/null

echo "integration: database ${DATABASE_URL%%\?*} and redis ${REDIS_URL}"
node -e "
  const { Client } = require('./services/click-worker/node_modules/pg');
  const url = new URL(process.env.DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  url.search = '';
  const c = new Client({ connectionString: url.toString() });
  c.connect()
    .then(() => c.query('SELECT 1 FROM pg_database WHERE datname = \$1', [name]))
    .then((r) => (r.rowCount === 0 ? c.query('CREATE DATABASE \"' + name + '\"') : null))
    .finally(() => c.end());
"
node -e "
  const { Redis } = require('./services/click-worker/node_modules/ioredis');
  const r = new Redis(process.env.REDIS_URL);
  r.flushdb().finally(() => r.disconnect());
"
pnpm --filter @links/db exec prisma migrate deploy >/dev/null
node scripts/db-drift.mjs
pnpm --filter @links/db exec tsx prisma/seed.mts
echo "  migrations applied, no drift, seeded"

echo "integration: redirect service (Go) against real Redis"
(cd services/redirect && REDIS_TEST_URL="$REDIS_URL" go test -count=1 -race ./internal/...)

echo "integration: click worker crash test"
pnpm --filter @links/click-worker exec vitest run --config vitest.integration.config.ts

echo "integration: starting redirect :${REDIRECT_PORT_IT} and worker :${WORKER_PORT_IT}"
REDIRECT_PORT="$REDIRECT_PORT_IT" TRUST_PROXY_HOPS=1 APP_BASE_URL="${APP_BASE_URL:-http://localhost:3000}" \
  services/redirect/bin/redirect >"$LOG_DIR/redirect.log" 2>&1 &
PIDS+=($!)
WORKER_HEALTH_PORT="$WORKER_PORT_IT" GEOIP_DB_PATH="$ROOT/data/test/GeoIP2-City-Test.mmdb" \
  WORKER_CLAIM_IDLE_MS=2000 node services/click-worker/dist/main.js >"$LOG_DIR/worker.log" 2>&1 &
PIDS+=($!)
for url in "$SHORT_BASE_URL/health" "$WORKER_INTERNAL_URL/health"; do
  for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && break
    sleep 0.2
  done
  curl -fsS -o /dev/null "$url" || { echo "$url never became healthy; logs in $LOG_DIR" >&2; exit 1; }
done

echo "integration: API suite"
if [[ $# -gt 0 ]]; then
  pnpm --filter @links/api exec vitest run --config vitest.integration.config.ts "$@"
else
  pnpm --filter @links/api exec vitest run --config vitest.integration.config.ts
fi

# The seed and every suite above went through the worker's writer; one last
# recount over the whole database.
pnpm --filter @links/db exec tsx prisma/recount.mts
