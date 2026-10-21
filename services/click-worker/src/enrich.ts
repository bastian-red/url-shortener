import { createHmac } from 'node:crypto';

import { isbot } from 'isbot';
import UAParser from 'ua-parser-js';

import type { ClickEvent } from '@links/shared';

/**
 * Turning one stream entry into one stored click. Pure: the geo database is
 * passed in, so every rule here is unit tested without a file or a network.
 *
 * The IP address enters this function and does not leave it. It is used for
 * the geo lookup and the visitor hash, and the returned row has no field that
 * could hold it (SPECS outcome 7).
 */

export interface GeoAnswer {
  country: string;
  region: string;
  city: string;
}

export type GeoLookup = (ip: string) => GeoAnswer | null;

export interface EnrichedClick {
  /** The stream entry id: the idempotency key. */
  id: string;
  at: Date;
  hour: Date;
  linkId: string;
  country: string;
  region: string;
  city: string;
  device: Device;
  browser: string;
  os: string;
  referrer: string;
  visitor: Buffer;
  isBot: boolean;
}

export type Device = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other';

const UNKNOWN_GEO: GeoAnswer = { country: '', region: '', city: '' };

export function hourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/**
 * The key for one UTC day, derived from the long-lived secret.
 *
 * Rotating daily is what stops the hash from following a person across days,
 * and deriving it from the CLICK's date (not "today") is what makes a click
 * redelivered after midnight hash the same as it did the first time.
 */
export function dailyKey(secret: string, at: Date): Buffer {
  return createHmac('sha256', secret).update(at.toISOString().slice(0, 10)).digest();
}

export function visitorHash(secret: string, at: Date, ip: string, ua: string): Buffer {
  return createHmac('sha256', dailyKey(secret, at)).update(`${ip}\n${ua}`).digest().subarray(0, 16);
}

/** The referring site, as a bare host: `https://www.t.co/x` -> `t.co`. `""` is direct. */
export function referrerHost(ref: string): string {
  if (ref === '') return '';
  try {
    const url = new URL(ref);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
}

export function classify(ua: string): {
  device: Device;
  browser: string;
  os: string;
  isBot: boolean;
} {
  // An empty user agent is a script, not a person: no browser sends none.
  const bot = ua.trim() === '' || isbot(ua);
  const parsed = new UAParser(ua).getResult();
  const type = parsed.device.type;
  const device: Device = bot
    ? 'bot'
    : type === 'mobile'
      ? 'mobile'
      : type === 'tablet'
        ? 'tablet'
        : type === undefined
          ? 'desktop'
          : 'other';
  return {
    device,
    browser: parsed.browser.name ?? '',
    os: parsed.os.name ?? '',
    isBot: bot,
  };
}

export function enrich(
  id: string,
  event: ClickEvent,
  geo: GeoLookup,
  secret: string,
): EnrichedClick {
  const at = new Date(Number(event.ts));
  const place = (event.ip === '' ? null : geo(event.ip)) ?? UNKNOWN_GEO;
  const kind = classify(event.ua);
  return {
    id,
    at,
    hour: hourOf(at),
    linkId: event.link,
    country: place.country,
    region: place.region,
    city: place.city,
    ...kind,
    referrer: referrerHost(event.ref),
    visitor: visitorHash(secret, at, event.ip, event.ua),
  };
}
