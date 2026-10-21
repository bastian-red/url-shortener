/**
 * Reports over the seeded hero link (about 30,000 clicks over 30 days, written
 * by the worker's own batch writer).
 *
 * The numbers are checked against each other rather than against constants:
 * every click contributes to the series, the totals, exactly one row of every
 * breakdown and one cell of the week grid, so all four must sum to the same
 * total. A query that dropped a bucket, double-counted a day boundary or leaked
 * bots into the human count breaks one of those equalities.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyticsSchema, DIMENSIONS, type Analytics } from '@links/shared';

import { boot, call, DEMO, loadSeed, type Harness } from './support';

let harness: Harness;
let heroId: string;

const HOUR = 3_600_000;
const now = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
const range = (days: number) => ({
  from: new Date(now - days * 24 * HOUR).toISOString(),
  to: new Date(now).toISOString(),
});

beforeAll(async () => {
  harness = await boot();
  ({ heroId } = await loadSeed(harness.db));
});

afterAll(async () => {
  await harness.close();
});

async function report(query: Record<string, string>): Promise<Analytics> {
  const reply = await call<Analytics>(
    harness,
    'GET',
    `/links/${heroId}/analytics?${new URLSearchParams(query).toString()}`,
    { user: DEMO },
  );
  expect(reply.status, reply.text).toBe(200);
  return analyticsSchema.parse(reply.body);
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('the 30-day report', () => {
  it('is internally consistent: series, totals, every breakdown and the week grid agree', async () => {
    const r = await report({ ...range(31) });
    expect(r.bucket).toBe('day');
    expect(r.totals.clicks).toBeGreaterThan(25_000);
    expect(sum(r.series.map((s) => s.clicks))).toBe(r.totals.clicks);
    for (const dimension of DIMENSIONS) {
      expect(sum(r.breakdowns[dimension].map((b) => b.clicks)), dimension).toBe(r.totals.clicks);
    }
    expect(sum(r.hourOfWeek.flat())).toBe(r.totals.clicks);
    expect(r.totals.visitors).toBeLessThan(r.totals.clicks);
    expect(r.breakdowns.device.map((d) => d.key)).not.toContain('bot');
  });

  it('zero-fills every bucket, so a chart axis has no gaps', async () => {
    const r = await report({ ...range(31) });
    expect(r.series.length).toBeGreaterThanOrEqual(31);
    expect(r.series.length).toBeLessThanOrEqual(32);
    const hourly = await report({ ...range(3) });
    expect(hourly.bucket).toBe('hour');
    expect(hourly.series).toHaveLength(72);
  });

  it('includes bots only when asked, and then everywhere', async () => {
    const humans = await report({ ...range(31) });
    const all = await report({ ...range(31), includeBots: 'true' });
    expect(all.totals.bots).toBeGreaterThan(0);
    expect(sum(all.series.map((s) => s.clicks))).toBe(humans.totals.clicks + all.totals.bots);
    expect(all.breakdowns.device.find((d) => d.key === 'bot')?.clicks).toBe(all.totals.bots);
  });

  it("cuts days at the viewer's midnight, not UTC's", async () => {
    const tz = 'America/Santiago';
    const r = await report({ ...range(31), tz });
    const localHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    for (const point of r.series) expect(localHour.format(new Date(point.t)), point.t).toBe('00');
    // Same clicks, regrouped: the total does not depend on the zone.
    expect(r.totals.clicks).toBe((await report({ ...range(31) })).totals.clicks);
  });
});

describe('refused queries', () => {
  it.each([
    [
      'a range that does not start on an hour',
      { from: '2026-10-01T00:30:00.000Z', to: '2026-10-02T00:00:00.000Z' },
    ],
    ['a range over 90 days', { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }],
    ['a reversed range', { from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }],
    [
      'a zone that does not exist',
      { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', tz: 'Mars/Olympus_Mons' },
    ],
  ])('refuses %s with 400', async (_name, query) => {
    const reply = await call(
      harness,
      'GET',
      `/links/${heroId}/analytics?${new URLSearchParams(query).toString()}`,
      { user: DEMO },
    );
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'INVALID' });
  });
});
