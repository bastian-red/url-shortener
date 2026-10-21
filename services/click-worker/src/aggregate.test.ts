import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { aggregate, merge, type Deltas } from './aggregate';
import type { Device, EnrichedClick } from './enrich';

const click = (over: Partial<EnrichedClick>): EnrichedClick => ({
  id: 'x',
  at: new Date('2026-10-21T14:10:00Z'),
  hour: new Date('2026-10-21T14:00:00Z'),
  linkId: 'a',
  country: 'GB',
  region: '',
  city: '',
  device: 'mobile',
  browser: 'Chrome',
  os: 'Android',
  referrer: '',
  visitor: Buffer.alloc(16),
  isBot: false,
  ...over,
});

describe('aggregate', () => {
  it('counts humans and bots separately, one rollup row per dimension value', () => {
    const d = aggregate([
      click({ id: '1' }),
      click({ id: '2', country: 'CL' }),
      click({ id: '3', isBot: true, device: 'bot', browser: '', os: '' }),
    ]);
    expect(d.hours).toEqual([
      { linkId: 'a', hour: new Date('2026-10-21T14:00:00Z'), clicks: 2, bots: 1 },
    ]);
    const country = d.rollups.filter((r) => r.dimension === 'country' && !r.isBot);
    expect(country.map((r) => [r.key, r.clicks])).toEqual([
      ['CL', 1],
      ['GB', 1],
    ]);
    // Each click contributes exactly one row per dimension: 5 dimensions x 3 clicks.
    expect(d.rollups.reduce((n, r) => n + r.clicks, 0)).toBe(15);
  });

  it('returns rows sorted by primary key, which is what prevents upsert deadlocks', () => {
    const d = aggregate([click({ linkId: 'b' }), click({ linkId: 'a' }), click({ linkId: 'c' })]);
    expect(d.hours.map((h) => h.linkId)).toEqual(['a', 'b', 'c']);
  });
});

const arbClick = fc.record({
  linkId: fc.constantFrom('a', 'b', 'c'),
  hour: fc.integer({ min: 0, max: 5 }),
  country: fc.constantFrom('', 'GB', 'CL', 'US'),
  device: fc.constantFrom<Device>('desktop', 'mobile', 'tablet', 'bot'),
  browser: fc.constantFrom('', 'Chrome', 'Firefox'),
  referrer: fc.constantFrom('', 't.co', 'news.ycombinator.com'),
});

describe('rollups equal a recount, however the clicks are split into batches', () => {
  // SPECS outcome 6, the pure half: the worker applies one batch's deltas at a
  // time, and the sum of any split must equal aggregating everything at once.
  // The integration lane checks the same thing against the real tables.
  it('holds over 300 random click sets and splits', () => {
    fc.assert(
      fc.property(
        fc.array(arbClick, { minLength: 1, maxLength: 200 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (specs, cuts) => {
          const clicks = specs.map((s, i) =>
            click({
              id: String(i),
              linkId: s.linkId,
              hour: new Date(Date.UTC(2026, 9, 21, s.hour)),
              country: s.country,
              device: s.device,
              isBot: s.device === 'bot',
              browser: s.browser,
              referrer: s.referrer,
            }),
          );
          const points = [...new Set(cuts.map((c) => c % clicks.length))].sort((a, b) => a - b);
          const batches: EnrichedClick[][] = [];
          let start = 0;
          for (const p of [...points, clicks.length]) {
            batches.push(clicks.slice(start, p));
            start = p;
          }
          const summed = batches
            .map(aggregate)
            .reduce<Deltas>((acc, d) => merge(acc, d), { hours: [], rollups: [] });
          expect(summed).toEqual(aggregate(clicks));
          // And the property is not vacuous: splits with more than one batch occur.
          return true;
        },
      ),
      { seed: 20261021, numRuns: 300 },
    );
  });

  it('the generator actually produces multi-batch splits (the property is not vacuous)', () => {
    let multi = 0;
    fc.assert(
      fc.property(
        fc.array(arbClick, { minLength: 2, maxLength: 50 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 10 }),
        (specs, cuts) => {
          if (new Set(cuts.map((c) => c % specs.length).filter((c) => c > 0)).size > 0) multi += 1;
        },
      ),
      { seed: 20261021, numRuns: 500 },
    );
    expect(multi).toBeGreaterThan(250);
  });
});
