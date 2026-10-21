#!/usr/bin/env bash
# Fetch the IP geolocation databases into data/ (gitignored).
#
#   ./scripts/geo-db.sh          # DB-IP City Lite (dev + compose) and the test fixture
#   ./scripts/geo-db.sh --test   # only the 18 KB test fixture (CI's unit lanes)
#
# DB-IP City Lite: CC BY 4.0, monthly, no account or licence key (MaxMind's
# GeoLite2 needs both, which a reader cloning the repo should not have to
# create). The licence requires attribution, which the web app's footer carries.
# https://db-ip.com/db/download/ip-to-city-lite
#
# GeoIP2-City-Test.mmdb: MaxMind's published test database (MIT / Apache-2.0),
# with known answers (81.2.69.160 is London, GB). The integration lane uses it
# so its geo assertions do not change when DB-IP publishes a new month.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
mkdir -p "$DATA/test"

TEST_DB="$DATA/test/GeoIP2-City-Test.mmdb"
if [[ ! -s "$TEST_DB" ]]; then
  curl -fsSL --retry 3 -o "$TEST_DB.part" \
    https://raw.githubusercontent.com/maxmind/MaxMind-DB/main/test-data/GeoIP2-City-Test.mmdb
  mv "$TEST_DB.part" "$TEST_DB"
  echo "geo-db: test fixture -> ${TEST_DB#"$ROOT"/}"
fi

[[ "${1:-}" == "--test" ]] && exit 0

CITY_DB="$DATA/dbip-city-lite.mmdb"
if [[ -s "$CITY_DB" && "${1:-}" != "--refresh" ]]; then
  echo "geo-db: ${CITY_DB#"$ROOT"/} already present (pass --refresh to update)"
  exit 0
fi

# This month's file appears a day or two into the month, so fall back to last
# month's rather than failing on the 1st.
for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz"
  if curl -fsSL --retry 3 -o "$CITY_DB.gz.part" "$url"; then
    gunzip -c "$CITY_DB.gz.part" > "$CITY_DB.part"
    rm -f "$CITY_DB.gz.part"
    mv "$CITY_DB.part" "$CITY_DB"
    echo "geo-db: DB-IP City Lite ${month} -> ${CITY_DB#"$ROOT"/} ($(du -h "$CITY_DB" | cut -f1))"
    exit 0
  fi
done
echo "geo-db: could not download DB-IP City Lite; clicks will be stored with an unknown country" >&2
exit 1
