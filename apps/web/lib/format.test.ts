/**
 * Every expected string below was produced by running the same Intl calls under
 * Node 20's ICU and pasted, never typed from memory: an expected value is
 * deterministic work too, and a remembered one invites "fixing" correct code.
 */
import { describe, expect, it } from 'vitest';

import { LINK_STATUSES } from '@links/shared';

import {
  bucketLabel,
  bucketTitle,
  countryName,
  dimensionLabel,
  formatCompact,
  formatCount,
  formatLatency,
  formatPercent,
  last24hSummary,
  shortDestination,
  STATUS_DISPLAY,
} from './format';

describe('numbers', () => {
  it('formats counts in full and axis ticks compactly', () => {
    expect(formatCount(30123)).toBe('30,123');
    expect(formatCompact(12400)).toBe('12.4K');
    expect(formatCompact(999)).toBe('999');
  });

  it('shows small shares with a decimal and never divides by zero', () => {
    expect(formatPercent(1, 40)).toBe('2.5%');
    expect(formatPercent(28, 100)).toBe('28%');
    expect(formatPercent(0, 0)).toBe('0%');
  });
});

describe('labels', () => {
  it('names countries and never leaves a blank cell', () => {
    expect(countryName('GB')).toBe('United Kingdom');
    expect(countryName('CL')).toBe('Chile');
    expect(countryName('')).toBe('Unknown');
    expect(dimensionLabel('referrer', '')).toBe('Direct / none');
    expect(dimensionLabel('browser', '')).toBe('Unknown');
    expect(dimensionLabel('device', 'mobile')).toBe('Mobile');
  });

  it('strips the scheme and a trailing slash from a destination', () => {
    expect(shortDestination('https://example.com/')).toBe('example.com');
    expect(shortDestination('http://example.com/a?b=1')).toBe('example.com/a?b=1');
  });
});

describe('time', () => {
  it('labels hour and day buckets in the given zone', () => {
    expect(bucketLabel('2026-10-21T14:00:00.000Z', 'hour', 'UTC')).toBe('14:00');
    expect(bucketLabel('2026-10-21T14:00:00.000Z', 'day', 'UTC')).toBe('21 Oct');
    expect(bucketTitle('2026-10-21T14:00:00.000Z', 'hour', 'UTC')).toBe('Wed 21 Oct, 14:00');
    // 02:00 UTC on the 21st is still the 20th in Santiago.
    expect(bucketTitle('2026-10-21T02:00:00.000Z', 'day', 'America/Santiago')).toBe('Tue 20 Oct');
  });
});

describe('status display', () => {
  it('gives every status a distinct glyph and a word', () => {
    const glyphs = LINK_STATUSES.map((s) => STATUS_DISPLAY[s].glyph);
    expect(new Set(glyphs).size).toBe(LINK_STATUSES.length);
    for (const s of LINK_STATUSES) expect(STATUS_DISPLAY[s].word.length).toBeGreaterThan(3);
  });
});

describe('status probes', () => {
  it('never prints a probe as 0 ms, which reads as one that did not run', () => {
    expect(formatLatency(0)).toBe('<1 ms');
    expect(formatLatency(98)).toBe('98 ms');
    expect(formatLatency(1234)).toBe('1,234 ms');
  });
});

describe('the ledger 24-hour cell', () => {
  it('says "no clicks" instead of drawing a flat line', () => {
    expect(last24hSummary(Array.from({ length: 24 }, () => 0))).toEqual({
      total: 0,
      text: 'No clicks in 24 h',
    });
    expect(last24hSummary([3, 0, 1204])).toEqual({ total: 1207, text: '1,207 in 24 h' });
  });
});
