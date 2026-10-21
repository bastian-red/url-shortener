#!/usr/bin/env bash
#
# Start the dev stack: load .env, check the datastores are reachable, hand off to
# turbo.
#
# `turbo run dev` on its own does not read .env. Turbo does not load dotenv files,
# and Next.js only reads a .env inside its own package directory (apps/web/.env),
# which this monorepo does not have. Three sibling projects in this portfolio
# shipped without this wrapper and their documented `pnpm dev` started an API with
# no AUTH_SECRET, which died at boot and left every server render failing with
# ECONNREFUSED. This repo has the wrapper from its first commit.
#
# The env-loading block below is deliberately the same shape as the one in
# scripts/e2e.sh, so the repo has one idiom for this rather than two that can
# drift apart.
#
# Usage: pnpm dev   (package.json points "dev" here)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cat >&2 <<'MSG'
No .env in the repo root.

  cp .env.example .env
  sed -i "s|^AUTH_SECRET=|AUTH_SECRET=$(openssl rand -base64 32)|" .env
  sed -i "s|^VISITOR_HASH_SECRET=|VISITOR_HASH_SECRET=$(openssl rand -base64 32)|" .env

See README.md, "Running it".
MSG
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Fail here, naming the variable, rather than 40 lines into a Nest stack trace.
# Both processes use it -- the web app mints the service token, the API checks
# it -- so a missing secret does not merely break sign-in, it makes every
# signed-in page fail, and an empty ledger looks like a broken query rather
# than a broken secret.
if [[ ${#AUTH_SECRET} -lt 16 ]]; then
  echo "AUTH_SECRET must be at least 16 characters. Generate one:" >&2
  echo "  sed -i \"s|^AUTH_SECRET=.*|AUTH_SECRET=\$(openssl rand -base64 32)|\" .env" >&2
  exit 1
fi

# The click worker hashes visitors with a key derived from this; it refuses to
# start without one, and a stack with no worker redirects fine and records
# nothing, which looks like "analytics are broken" rather than "a secret is
# missing".
if [[ ${#VISITOR_HASH_SECRET} -lt 16 ]]; then
  echo "VISITOR_HASH_SECRET must be at least 16 characters. Generate one:" >&2
  echo "  sed -i \"s|^VISITOR_HASH_SECRET=.*|VISITOR_HASH_SECRET=\$(openssl rand -base64 32)|\" .env" >&2
  exit 1
fi

# The redirect service is Go; turbo runs it with `go run`.
if ! command -v go >/dev/null 2>&1; then
  echo "Go is not on PATH. The redirect service needs Go $(sed -n 's/^go //p' services/redirect/go.mod):" >&2
  echo "  https://go.dev/dl/  (or: docker compose -f infra/docker-compose.yml --profile app up -d)" >&2
  exit 1
fi

# Without the geo database the worker still records every click, with an
# unknown country. Fetch it once rather than ship a dashboard of "Unknown".
if [[ -z "${GEOIP_DB_PATH:-}" && ! -s data/dbip-city-lite.mmdb ]]; then
  echo "dev: fetching the IP geolocation database (once, ~60 MB)..." >&2
  ./scripts/geo-db.sh || echo "dev: continuing without it; countries will show as Unknown." >&2
fi

# Postgres and Redis being absent is the other failure that presents as a slow or
# broken page rather than as an error, so it gets named up front too. Uses bash's
# own /dev/tcp rather than nc, which is not installed everywhere.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0 # No explicit host:port to check. Let the app report it.
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
check_reachable "${DATABASE_URL:-}" Postgres || failed=1
# Redis is not optional: every redirect answers from it.
check_reachable "${REDIS_URL:-}" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# `exec` so Ctrl-C reaches turbo directly and the persistent tasks shut down
# cleanly instead of being orphaned behind a wrapper shell.
exec pnpm exec turbo run dev "$@"
