import { describe, expect, it } from 'vitest';

import { brushRange, bucketAt, presetRange } from './range';

describe('presetRange', () => {
  it('ends at the end of the current hour and lands on hour boundaries', () => {
    const now = new Date('2026-10-21T14:37:12.000Z');
    expect(presetRange('24h', now)).toEqual({
      from: '2026-10-20T15:00:00.000Z',
      to: '2026-10-21T15:00:00.000Z',
    });
  });

  it('still includes the current hour when now is exactly on the boundary', () => {
    const now = new Date('2026-10-21T14:00:00.000Z');
    expect(presetRange('24h', now).to).toBe('2026-10-21T15:00:00.000Z');
  });

  it('keeps 90 days inside the API maximum', () => {
    const r = presetRange('90d', new Date('2026-10-21T14:37:00Z'));
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(90 * 24 * 3_600_000);
  });
});

describe('brushRange', () => {
  const buckets = [
    '2026-10-01T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
    '2026-10-03T00:00:00.000Z',
  ];
  const end = '2026-10-04T00:00:00.000Z';

  it('covers both ends inclusively, whichever way the drag went', () => {
    expect(brushRange(buckets, end, 0, 1)).toEqual({ from: buckets[0], to: buckets[2] });
    expect(brushRange(buckets, end, 1, 0)).toEqual({ from: buckets[0], to: buckets[2] });
  });

  it('runs the last bucket to the end of the report', () => {
    expect(brushRange(buckets, end, 2, 2)).toEqual({ from: buckets[2], to: end });
  });

  it('clamps out-of-range indexes', () => {
    expect(brushRange(buckets, end, -5, 99)).toEqual({ from: buckets[0], to: end });
    expect(brushRange([], end, 0, 1)).toBeNull();
  });
});

describe('bucketAt', () => {
  it('maps an x position to a bucket and clamps the edges', () => {
    expect(bucketAt(0, 300, 30)).toBe(0);
    expect(bucketAt(299.9, 300, 30)).toBe(29);
    expect(bucketAt(300, 300, 30)).toBe(29);
    expect(bucketAt(-10, 300, 30)).toBe(0);
    expect(bucketAt(155, 300, 30)).toBe(15);
  });
});
