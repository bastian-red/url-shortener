#!/usr/bin/env bash
#
# `.env` then node. The check itself is scripts/db-drift.mjs; this only supplies
# DATABASE_URL the same three-step way integration.sh and seed-check.sh do, so
# the lane runs identically here and on CI, where the URL arrives through the
# job's environment and no dotenv file is ever written.
set -euo pipefail

cd "$(dirname "$0")/.."

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

export DATABASE_URL="${DATABASE_URL:-postgresql://links:links@localhost:5442/links?schema=public}"

# db-drift.mjs imports @links/db's built dist (the constraint names live there),
# and a fresh clone has none: CI's first run died with ERR_MODULE_NOT_FOUND here.
# Turbo makes this a cache hit whenever the package is already built.
pnpm exec turbo run build --filter=@links/db --output-logs=errors-only >/dev/null

exec node scripts/db-drift.mjs
