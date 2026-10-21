#!/usr/bin/env bash
#
# Prove the DOCUMENTED `pnpm dev` serves a working app from a cold start.
#
# Every other lane supplies its own environment (e2e.sh and integration.sh source
# .env and start the apps directly, bypassing turbo), so none of them can see the
# failure that sank three sibling projects for months: turbo in strict env mode
# stripping names the app needs, and `pnpm dev` booting an API with no
# AUTH_SECRET. This script strips every .env name from its own environment with
# `env -u` and runs `pnpm dev` exactly as the README says, so the only way the
# configuration can reach the processes is the path a reader's machine uses:
# scripts/dev.sh sourcing .env, turbo passing declared names through.
#
# Assert on content, never on a status code. A broken app answers 200 with an
# error page. So this requires, across all four processes: every /health ok
# (api, redirect, worker); a sign-in through Auth.js; the seeded hero link on the
# ledger; its report with real country names; the Go redirect answering 302 with
# the seeded destination; and that very visit counted by the worker.
#
# Negative check: point "dev" in package.json back at
# `turbo run dev` and this fails, because nothing then loads .env.
#
# Usage: ./scripts/dev-smoke.sh      (datastores up, migrated, seeded)
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${LOG:-/tmp/shortener-dev-smoke.log}"
COOKIES="$(mktemp -t shortener-dev-smoke-cookies.XXXXXX)"
DEV_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-120}"

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f .env ]] || die "no .env in the repo root. See README.md, 'Running it'."

env_value() { sed -n "s/^[[:space:]]*$1=//p" .env | tail -1; }
API_PORT="$(env_value API_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
REDIRECT_PORT="$(env_value REDIRECT_PORT)"
WORKER_HEALTH_PORT="$(env_value WORKER_HEALTH_PORT)"
API_BASE_URL="http://localhost:${API_PORT:-4000}"
APP_BASE_URL="http://localhost:${WEB_PORT:-3000}"
REDIRECT_BASE_URL="http://localhost:${REDIRECT_PORT:-8080}"
WORKER_BASE_URL="http://localhost:${WORKER_HEALTH_PORT:-4100}"

# The seeded facts, read out of the seed rather than retyped.
SEED=packages/db/prisma/seed.mts
seed_const() { sed -n "s/^const $1 = '\([^']*\)';.*/\1/p" "$SEED"; }
DEMO_EMAIL="$(seed_const DEMO_EMAIL)"
DEMO_PASSWORD="$(seed_const DEMO_PASSWORD)"
HERO_SLUG="$(seed_const HERO_SLUG)"
HERO_URL="$(seed_const HERO_URL)"
HERO_TITLE="$(seed_const HERO_TITLE)"
for pair in "DEMO_EMAIL:$DEMO_EMAIL" "DEMO_PASSWORD:$DEMO_PASSWORD" "HERO_SLUG:$HERO_SLUG" \
  "HERO_URL:$HERO_URL" "HERO_TITLE:$HERO_TITLE"; do
  [[ -n "${pair#*:}" ]] || die "could not read ${pair%%:*} out of ${SEED}."
done

for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/sign-in" "${REDIRECT_BASE_URL}/health" "${WORKER_BASE_URL}/health"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    die "something is already serving ${url}. Stop it first."
  fi
done

# Cold, like a fresh clone: no app build output for `dev` to lean on. The
# workspace packages' dist/ is left alone deliberately -- `dev` dependsOn ^build,
# and whether that rebuild happens is part of what is being tested; CI runs this
# on a checkout that has none at all.
echo "==> Removing app build outputs"
for stale in apps/*/dist apps/*/.next; do
  [[ -e "$stale" ]] || continue
  rm -rf "${ROOT:?}/${stale}"
  echo "    removed ${stale}"
done

mapfile -t ENV_KEYS < <(
  sed -n 's/^[[:space:]]*#\?[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' .env.example .env | sort -u
)
[[ ${#ENV_KEYS[@]} -gt 0 ]] || die "parsed no variable names out of .env.example."
UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

echo "==> Starting: pnpm dev (${#ENV_KEYS[@]} .env names stripped from the child environment)"
echo "    log: ${LOG}"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

wait_for() {
  local url="$1" name="$2"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    curl -sf -o /dev/null "$url" 2>/dev/null && return 0
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 150 lines of ${LOG}:" >&2
      tail -150 "$LOG" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 150 lines of ${LOG}:" >&2
  tail -150 "$LOG" >&2
  exit 1
}
echo "==> Waiting for api, web, redirect and worker"
wait_for "${API_BASE_URL}/health" api
wait_for "${APP_BASE_URL}/sign-in" web
wait_for "${REDIRECT_BASE_URL}/health" redirect
wait_for "${WORKER_BASE_URL}/health" click-worker

json_field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); } catch {}
    });' "$1"
}

echo "==> Checking /health reports every dependency ok"
for pair in "api:${API_BASE_URL}" "redirect:${REDIRECT_BASE_URL}" "click-worker:${WORKER_BASE_URL}"; do
  body="$(curl -s "${pair#*:}/health")"
  [[ "$(json_field status <<<"$body")" == "ok" ]] ||
    die "${pair%%:*} /health is not ok: ${body}"
done

echo "==> Signing in as ${DEMO_EMAIL} through Auth.js"
csrf="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/csrf" | json_field csrfToken)"
[[ -n "$csrf" ]] || die "GET /api/auth/csrf returned no csrfToken. Auth.js is not mounted."
curl -s -o /dev/null -L -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "csrfToken=${csrf}" \
  --data-urlencode "email=${DEMO_EMAIL}" \
  --data-urlencode "password=${DEMO_PASSWORD}" \
  "${APP_BASE_URL}/api/auth/callback/credentials"
session="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/session")"
grep -qF "$DEMO_EMAIL" <<<"$session" || {
  tail -150 "$LOG" >&2
  die "sign-in produced no session (${session}). AUTH_SECRET never reached a process, or the seed did not run."
}

echo "==> Checking the ledger renders the seeded hero link"
list="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}/")"
grep -qF "$HERO_TITLE" <<<"$list" || {
  tail -150 "$LOG" >&2
  die "/ does not contain '${HERO_TITLE}'. It is an error page or an empty shell."
}
LINK_ID="$(grep -o "href=\"/links/[a-z0-9]*\">${HERO_TITLE}<" <<<"$list" | head -1 | sed 's|href="/links/||; s|".*||')"
[[ -n "$LINK_ID" ]] || die "/ rendered no link page for '${HERO_TITLE}'."

echo "==> Checking /links/${LINK_ID} renders a report from the rollups"
detail="$(curl -s -L -b "$COOKIES" "${APP_BASE_URL}/links/${LINK_ID}?range=30d")"
grep -qF "United States" <<<"$detail" || {
  tail -150 "$LOG" >&2
  die "the link page has no country breakdown. The analytics read path is broken."
}

echo "==> Visiting ${REDIRECT_BASE_URL}/${HERO_SLUG} through the Go redirect service"
before="$(curl -s "${API_BASE_URL}/status" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(r).pipeline.inserted))}catch{process.stdout.write("x")}})')"
[[ "$before" =~ ^[0-9]+$ ]] || die "GET /status reported no pipeline numbers. The API cannot reach the worker."
headers="$(curl -s -o /dev/null -D - -A 'Mozilla/5.0 (dev-smoke)' "${REDIRECT_BASE_URL}/${HERO_SLUG}")"
grep -qi "^HTTP/1.1 302" <<<"$headers" || die "the redirect did not answer 302: ${headers}"
location="$(sed -n 's/^[Ll]ocation: //p' <<<"$headers" | tr -d '\r')"
[[ "$location" == "$HERO_URL" ]] || die "the redirect went to '${location}', not '${HERO_URL}'."

echo "==> Waiting for the worker to count that visit"
for _ in $(seq 1 20); do
  after="$(curl -s "${API_BASE_URL}/status" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(r).pipeline.inserted))}catch{process.stdout.write("0")}})')"
  [[ "$after" -gt "$before" ]] && break
  sleep 0.5
done
[[ "$after" -gt "$before" ]] || die "the visit never reached Postgres (worker inserted ${before} -> ${after})."

echo
echo "PASS: pnpm dev serves all four processes, configured by .env alone, and a visit travels redirect -> stream -> worker -> Postgres."
