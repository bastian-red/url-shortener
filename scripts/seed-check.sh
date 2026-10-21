#!/usr/bin/env bash
#
# Prove the seed is deterministic, idempotent, and leaves consistent rollups.
#
#   deterministic   two runs produce the same content digest. Timestamps are
#                   digested RELATIVE to the seed's anchor (the demo account's
#                   creation), because the seed anchors to the current hour on
#                   purpose: a dashboard of September's clicks is empty to
#                   anyone who clones the repo in November.
#   idempotent      the second run replaces the first instead of adding to it:
#                   same digest AND the click total the seed declares.
#   consistent      the rollups equal a recount of the raw clicks. A seed that
#                   wrote rollups by hand would demonstrate numbers the worker
#                   could never produce; this one writes through the worker's
#                   own batch writer, and this proves it.
#
#   ./scripts/seed-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

exec node scripts/seed-check.mjs
