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
  formatPercent,
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
