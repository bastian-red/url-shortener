import { SLUG_PATTERN } from '@links/shared';

/**
 * Slug generation and the reserved list.
 *
 * Generated slugs are 7 base62 characters drawn from a CSPRNG: 62^7 = 3.5e12
 * values. They are not sequential on purpose. A counter encoded in base62 is
 * shorter, but it lets anyone enumerate every link ever made by counting, and
 * shortened links routinely carry unlisted documents and signed URLs.
 *
 * Collisions are handled by the database, not predicted here: the API inserts,
 * and on a unique violation draws again (up to `MAX_ATTEMPTS`). At 1e6 links
 * the chance one draw collides is 1e6 / 3.5e12 = 2.9e-7.
 */

export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const GENERATED_SLUG_LENGTH = 7;
export const MAX_ATTEMPTS = 5;

/**
 * Rejection threshold: the largest multiple of 62 that fits in a byte is 248.
 * A byte >= 248 is discarded, because `byte % 62` over the full 0..255 range
 * would make the first 8 characters (256 - 248) about 25% more likely than the
 * rest. Small, but it is free to avoid and it is the kind of bias that ends up
 * in a write-up.
 */
const REJECT_AT = 248;

export type RandomBytes = (size: number) => Uint8Array;

export function generateSlug(random: RandomBytes, length = GENERATED_SLUG_LENGTH): string {
  let slug = '';
  while (slug.length < length) {
    // Over-draw so one call almost always suffices: 3% of bytes are rejected.
    for (const byte of random(length * 2)) {
      if (byte >= REJECT_AT) continue;
      slug += BASE62[byte % 62];
      if (slug.length === length) break;
    }
  }
  return slug;
}

/**
 * Paths the short domain itself answers, plus words that would read as the
 * service speaking (`admin`, `login`). Compared case-insensitively: slugs are
 * case-sensitive, but `Health` beside `/health` is a phishing aid, not a link.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'health',
  'metrics',
  'status',
  'api',
  'admin',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'account',
  'settings',
  'dashboard',
  'links',
  'static',
  'assets',
  'public',
  'robots',
  'favicon',
  'sitemap',
  'well-known',
  'www',
  'app',
  'help',
  'support',
  'abuse',
  'security',
]);

export type SlugIssue = 'grammar' | 'reserved';

/** Why a custom slug is refused, or null if it is acceptable. */
export function customSlugIssue(slug: string): SlugIssue | null {
  if (!SLUG_PATTERN.test(slug)) return 'grammar';
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return 'reserved';
  return null;
}
