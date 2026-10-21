/**
 * The API's half of the redirect cache: write-through on every link change.
 *
 * The redirect service answers from `l:{slug}` and only reads Postgres on a
 * miss, so a change the API makes in Postgres is invisible to visitors until
 * the cache says so. The API therefore writes the record itself, always
 * overwriting (the redirect service's miss path is the one that never
 * overwrites; populate.lua explains the race that asymmetry closes).
 *
 * It never DELETES a record. A deleted link becomes a negative entry
 * (`nf: "1"`), because a deleted key lets the very next request miss, read a
 * Postgres replica that has not seen the delete yet, and resurrect the link.
 */
import type { Redis } from 'ioredis';

import { LINK_CACHE_PREFIX, type LinkCache } from '@links/shared';

export interface CacheableLink {
  id: string;
  url: string;
  expiresAt: Date | null;
  maxClicks: number | null;
  disabled: boolean;
  deletedAt: Date | null;
}

/** The hash fields, in the shape contracts/link-cache.schema.json describes. */
export function cacheRecord(link: CacheableLink): LinkCache {
  if (link.deletedAt !== null) {
    return { id: '', url: '', exp: '0', max: '0', dis: '0', nf: '1' };
  }
  return {
    id: link.id,
    url: link.url,
    exp: String(link.expiresAt?.getTime() ?? 0),
    max: String(link.maxClicks ?? 0),
    dis: link.disabled ? '1' : '0',
    nf: '0',
  };
}

export async function writeThrough(
  redis: Redis,
  slug: string,
  link: CacheableLink,
  ttlSeconds: number,
): Promise<void> {
  const key = `${LINK_CACHE_PREFIX}${slug}`;
  // MULTI so a reader never sees a half-written hash (new url, old dis).
  const result = await redis.multi().hset(key, cacheRecord(link)).expire(key, ttlSeconds).exec();
  const failed = result?.find(([error]) => error !== null);
  if (result === null || failed !== undefined) {
    throw new Error(
      `redirect cache write failed for ${slug}: ${String(failed?.[0] ?? 'transaction aborted')}`,
    );
  }
}
