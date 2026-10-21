#!/usr/bin/env bash
#
# The E2E lane: build in production mode, reseed, start all four processes
# (api, web, the Go redirect service, the click worker), run Playwright.
# Arguments go straight to `playwright test`.
#
# This lane supplies its own environment and starts the apps directly, bypassing
# turbo -- which is exactly why it proves nothing about whether the documented
# `pnpm dev` works. That is scripts/dev-smoke.sh's job, and it strips the
# environment first.
#
# The API's auth and create budgets are lifted: every browser sign-in reaches
# the API from this one machine, so the documented 5/min would turn the third
# spec into a 429. The integration lane is where those budgets are asserted, at
# their documented values. The redirect budget is NOT lifted: specs visit short
# links from random X-Forwarded-For addresses (TRUST_PROXY_HOPS=1, the lane
# playing the proxy), which is how real traffic is keyed.
#
# Usage: ./scripts/e2e.sh [playwright args...]
set -euo pipefail
set -m # each background job leads its own process group, so cleanup kills the whole tree

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-/tmp/shortener-e2e}"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
REDIRECT_LOG="$LOG_DIR/redirect.log"
WORKER_LOG="$LOG_DIR/worker.log"
API_PID=""
WEB_PID=""
REDIRECT_PID=""
WORKER_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$WEB_PID" "$API_PID" "$REDIRECT_PID" "$WORKER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

export DATABASE_URL="${DATABASE_URL:-postgresql://links:links@localhost:5442/links?schema=public}"
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6388}"
[[ -n "${AUTH_SECRET:-}" ]] || export AUTH_SECRET=ci-secret-at-least-32-characters-long
[[ -n "${VISITOR_HASH_SECRET:-}" ]] || export VISITOR_HASH_SECRET=ci-visitor-secret-32-characters-x
export APP_VERSION="${APP_VERSION:-0.1.0}"
export API_PORT="${API_PORT:-4000}"
export WEB_PORT="${WEB_PORT:-3000}"
export PORT=""
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"
export AUTH_URL="${AUTH_URL:-$APP_BASE_URL}"
export REDIRECT_PORT="${REDIRECT_PORT:-8080}"
export WORKER_HEALTH_PORT="${WORKER_HEALTH_PORT:-4100}"
export SHORT_BASE_URL="${SHORT_BASE_URL:-http://localhost:${REDIRECT_PORT}}"
export REDIRECT_INTERNAL_URL="${REDIRECT_INTERNAL_URL:-$SHORT_BASE_URL}"
export WORKER_INTERNAL_URL="${WORKER_INTERNAL_URL:-http://localhost:${WORKER_HEALTH_PORT}}"
export TRUST_PROXY_HOPS=1
# MaxMind's test database: 81.2.69.160 is London, GB, every month, so the
# geo assertions do not move when DB-IP publishes new data.
export GEOIP_DB_PATH="$ROOT/data/test/GeoIP2-City-Test.mmdb"
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=90000
export RATE_LIMIT_CREATE=90000

check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0
  fi
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[3]}"
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    echo "${label} is not reachable at ${host}:${port}. Start the datastores:" >&2
    echo "  docker compose -f infra/docker-compose.yml up -d" >&2
    return 1
  fi
}
failed=0
check_reachable "$DATABASE_URL" Postgres || failed=1
check_reachable "$REDIS_URL" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# Refuse to run against something already listening: the suite would test that
# instead, with whatever environment and build it happens to have.
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/sign-in" "${SHORT_BASE_URL}/health" "${WORKER_INTERNAL_URL}/health"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first (pnpm dev?)." >&2
    exit 1
  fi
done

echo "==> Building (production)"
NODE_ENV=production pnpm build >"$LOG_DIR/build.log" 2>&1 || {
  tail -40 "$LOG_DIR/build.log" >&2
  exit 1
}

./scripts/geo-db.sh --test >/dev/null

echo "==> Applying migrations and seeding"
pnpm --filter @links/db exec prisma migrate deploy >/dev/null
pnpm --filter @links/db run seed >"$LOG_DIR/seed.log" 2>&1 || {
  tail -30 "$LOG_DIR/seed.log" >&2
  exit 1
}

echo "==> Starting api :${API_PORT}, web :${WEB_PORT}, redirect :${REDIRECT_PORT}, worker :${WORKER_HEALTH_PORT} (logs in ${LOG_DIR})"
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!
services/redirect/bin/redirect >"$REDIRECT_LOG" 2>&1 &
REDIRECT_PID=$!
node services/click-worker/dist/main.js >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
(cd apps/web && exec node_modules/.bin/next start -p "$WEB_PORT") >"$WEB_LOG" 2>&1 &
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Last 30 lines of ${log}:" >&2
      tail -30 "$log" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 30 lines of ${log}:" >&2
  tail -30 "$log" >&2
  exit 1
}
wait_for "${API_BASE_URL}/health" api "$API_PID" "$API_LOG"
wait_for "${APP_BASE_URL}/sign-in" web "$WEB_PID" "$WEB_LOG"
wait_for "${SHORT_BASE_URL}/health" redirect "$REDIRECT_PID" "$REDIRECT_LOG"
wait_for "${WORKER_INTERNAL_URL}/health" click-worker "$WORKER_PID" "$WORKER_LOG"

echo "==> Running Playwright"
pnpm --filter @links/e2e exec playwright test "$@"
