/**
 * Formatting for display. Pure, and pinned by tests whose expected strings
 * were produced by running these functions, not typed from memory: `Intl`
 * output depends on the ICU data, and a remembered expectation is how a
 * correct formatter gets "fixed" into a wrong one.
 */
import type { LinkStatus } from '@links/shared';

const count = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return count.format(value);
}

/** 12,400 -> "12.4K". For axis ticks only; every exact value is also shown in full. */
export function formatCompact(value: number): string {
  return compact.format(value);
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return '0%';
  const pct = (part / whole) * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct).toString()}%`;
}

/**
 * A probe latency for the status page. Probes report whole milliseconds, so a
 * fast local check reads 0, and "0 ms" looks like a probe that never ran.
 */
export function formatLatency(ms: number): string {
  return ms < 1 ? '<1 ms' : `${count.format(ms)} ms`;
}

/**
 * The 24-hour cell of a ledger row, in words: a link with no clicks says so
 * instead of drawing a flat line that looks the same as a quiet live one.
 */
export function last24hSummary(values: readonly number[]): { total: number; text: string } {
  const total = values.reduce((a, b) => a + b, 0);
  return { total, text: total === 0 ? 'No clicks in 24 h' : `${count.format(total)} in 24 h` };
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** "GB" -> "United Kingdom"; "" -> "Unknown". */
export function countryName(code: string): string {
  if (code === '') return 'Unknown';
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The breakdown label for a key: unknown values get a word, never an empty cell. */
export function dimensionLabel(dimension: string, key: string): string {
  if (dimension === 'country') return countryName(key);
  if (key === '') return dimension === 'referrer' ? 'Direct / none' : 'Unknown';
  if (dimension === 'device') return key.charAt(0).toUpperCase() + key.slice(1);
  return key;
}

/**
 * Every status as a glyph AND a word (DESIGN.md: colour is never the only
 * channel). The glyphs are distinct shapes, so the five states stay apart in
 * greyscale and to a reader who cannot tell the colours apart.
 */
export const STATUS_DISPLAY: Record<
  LinkStatus,
  { glyph: string; word: string; tone: 'ok' | 'warn' | 'off' }
> = {
  active: { glyph: '●', word: 'Active', tone: 'ok' },
  expiring: { glyph: '◔', word: 'Expires soon', tone: 'warn' },
  expired: { glyph: '⌛', word: 'Expired', tone: 'off' },
  limit_reached: { glyph: '⊘', word: 'Limit reached', tone: 'off' },
  disabled: { glyph: '⏸', word: 'Turned off', tone: 'off' },
};

/** The destination without its scheme, for a ledger row: `https://example.com/a` -> `example.com/a`. */
export function shortDestination(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
}

const timeOfDay = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "14:37:12" in the viewer's zone (the formatter runs in the browser for the live tape). */
export function clock(iso: string, timeZone?: string): string {
  return timeZone === undefined
    ? timeOfDay.format(new Date(iso))
    : new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZone,
      }).format(new Date(iso));
}

/** A bucket's label: "14:00" for an hour, "21 Oct" for a day. */
export function bucketLabel(iso: string, bucket: 'hour' | 'day', timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    bucket === 'hour'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }
      : { day: 'numeric', month: 'short', timeZone };
  return new Intl.DateTimeFormat('en-GB', options).format(new Date(iso));
}

/** Long form for a tooltip: "Tue 21 Oct, 14:00" or "Tue 21 Oct". */
export function bucketTitle(iso: string, bucket: 'hour' | 'day', timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    bucket === 'hour'
      ? {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone,
        }
      : { weekday: 'short', day: 'numeric', month: 'short', timeZone };
  return new Intl.DateTimeFormat('en-GB', options).format(new Date(iso));
}
