import { z } from 'zod';

/**
 * One entry on the `clicks` Redis Stream: written by `services/redirect` (Go),
 * read by `services/click-worker` (Node).
 *
 * Two languages share this shape, so neither owns it. The authority is
 * `contracts/click-event.schema.json`; this zod schema and the Go encoder are
 * both tested against the golden fixture next to it
 * (`contracts/fixtures/click-event.json`), and the JSON Schema is tested against
 * this one, so the three cannot drift apart without a red gate.
 *
 * Stream fields are flat strings: Redis has no other type. Numbers are decimal
 * strings and absent values are `""`, never a missing field, so the worker's
 * parse is total.
 *
 * `ip` is the one field that must never reach Postgres. The worker uses it for
 * the geo lookup and the visitor hash, then drops it (SPECS outcome 7).
 */
export const CLICK_EVENT_VERSION = '1';
export const CLICK_STREAM = 'clicks';

const decimal = z.string().regex(/^\d+$/u);

export const clickEventSchema = z
  .object({
    v: z.literal(CLICK_EVENT_VERSION),
    link: z.string().min(1),
    slug: z.string().min(1),
    /** Milliseconds since the epoch, from the redirect service's clock. */
    ts: decimal,
    ip: z.string().max(45),
    ua: z.string().max(512),
    ref: z.string().max(512),
    lang: z.string().max(64),
  })
  .strict();

export type ClickEvent = z.infer<typeof clickEventSchema>;

/**
 * The Redis hash at `l:{slug}`: what the redirect service answers from.
 *
 * Written by `apps/api` on every link write (write-through) and by the redirect
 * service itself on a cache miss. `nf: "1"` is a negative-cache entry for a slug
 * that does not exist. Times are epoch milliseconds, `"0"` meaning none.
 */
export const linkCacheSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    exp: decimal,
    max: decimal,
    dis: z.enum(['0', '1']),
    nf: z.enum(['0', '1']),
  })
  .strict();

export type LinkCache = z.infer<typeof linkCacheSchema>;

export const LINK_CACHE_PREFIX = 'l:';
export const CLICK_COUNT_PREFIX = 'n:';
