import type { LinkStatus } from './contracts/links';

/**
 * A link's status, derived and never stored.
 *
 * Stored status goes stale the moment an expiry passes with nobody writing the
 * row; derived status cannot. The API computes it per response and the web app
 * renders it with a glyph and a word (DESIGN.md: colour is never the only
 * channel).
 *
 * Precedence is the order a visitor would experience it: a disabled link is
 * refused whatever else is true, then an expired one, then one out of clicks.
 */

/** "Expires soon" means within a day. */
export const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StatusInput {
  disabled: boolean;
  expiresAt: Date | null;
  maxClicks: number | null;
  /** Redirects granted so far (the Redis counter, not the analytics count). */
  redirects: number;
}

export function linkStatus(link: StatusInput, now: Date): LinkStatus {
  if (link.disabled) return 'disabled';
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (link.maxClicks !== null && link.redirects >= link.maxClicks) return 'limit_reached';
  if (link.expiresAt !== null && link.expiresAt.getTime() - now.getTime() <= EXPIRING_WINDOW_MS) {
    return 'expiring';
  }
  return 'active';
}
