import { existsSync } from 'node:fs';

import maxmind, { type CityResponse } from 'maxmind';

import type { GeoAnswer, GeoLookup } from './enrich';

/**
 * IP geolocation from a MaxMind-format database (DB-IP City Lite in dev and
 * compose, MaxMind's test database in the integration lane). Lookups are
 * in-memory and synchronous after the file is opened: no network call per
 * click, and no third party ever sees a visitor's address.
 */

export interface Geo {
  lookup: GeoLookup;
  /** Why geo is unavailable, or null. Reported by /health rather than crashing the worker. */
  problem: string | null;
}

export function answerFrom(record: CityResponse | null): GeoAnswer | null {
  if (record === null) return null;
  return {
    country: record.country?.iso_code ?? record.registered_country?.iso_code ?? '',
    region: record.subdivisions?.[0]?.names?.en ?? '',
    city: record.city?.names?.en ?? '',
  };
}

export async function openGeo(path: string): Promise<Geo> {
  if (!existsSync(path)) {
    // Clicks are still recorded, with an unknown country. Losing the click
    // because the geo file is missing would be the wrong trade.
    return { lookup: () => null, problem: `no database at ${path}; run pnpm geo:download` };
  }
  const reader = await maxmind.open<CityResponse>(path, { watchForUpdates: false });
  return {
    lookup: (ip) => {
      try {
        return answerFrom(reader.get(ip));
      } catch {
        // Not an IP address: the redirect service fell back to a socket peer
        // that is not one (a unix socket in some test setups).
        return null;
      }
    },
    problem: null,
  };
}
