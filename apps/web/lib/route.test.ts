import { describe, expect, it } from 'vitest';

import { BOARD_W, HUB_X, MAX_STROKE, MIN_STROKE, ROW_H, routeBoard, rowCentre } from './route';

describe('the route board', () => {
  const inbound = [
    { key: '', clicks: 218 },
    { key: 'slack.com', clicks: 67 },
    { key: 'discord.com', clicks: 33 },
  ];
  const outbound = [
    { key: 'US', clicks: 97 },
    { key: 'GB', clicks: 40 },
    { key: 'DE', clicks: 32 },
    { key: 'IN', clicks: 30 },
    { key: 'NL', clicks: 17 },
  ];
  const board = routeBoard(inbound, outbound);

  it('is as tall as its longer side, with the hub in the middle', () => {
    expect(board.height).toBe(5 * ROW_H);
    expect(board.hubY).toBe((5 * ROW_H) / 2);
  });

  it('ends every leg on the centre of its own row, the shorter side centred', () => {
    const ins = board.legs.filter((l) => l.side === 'in').map((l) => l.y);
    const outs = board.legs.filter((l) => l.side === 'out').map((l) => l.y);
    expect(outs).toEqual([0, 1, 2, 3, 4].map((i) => ROW_H * i + ROW_H / 2));
    // Three rows in a five-row board start one row down.
    expect(ins).toEqual([ROW_H * 1.5, ROW_H * 2.5, ROW_H * 3.5]);
    expect(rowCentre(0, 3, 5 * ROW_H)).toBe(ROW_H * 1.5);
  });

  it('joins rows to the hub, never a referrer to a country', () => {
    for (const leg of board.legs) {
      const hub = `${String(HUB_X)} ${String(board.hubY)}`;
      if (leg.side === 'in') {
        expect(leg.d.startsWith('M0 ')).toBe(true);
        expect(leg.d.endsWith(hub)).toBe(true);
      } else {
        expect(leg.d.startsWith(`M${hub}`)).toBe(true);
        expect(leg.d.endsWith(`${String(BOARD_W)} ${String(leg.y)}`)).toBe(true);
      }
    }
  });

  it('weighs each side against itself: the top row of each side is the heaviest leg', () => {
    const byKey = Object.fromEntries(board.legs.map((l) => [`${l.side}:${l.key}`, l.width]));
    expect(byKey['in:']).toBe(MAX_STROKE);
    expect(byKey['out:US']).toBe(MAX_STROKE);
    expect(byKey['out:NL']).toBeGreaterThan(MIN_STROKE);
    expect(byKey['out:NL']).toBeLessThan(byKey['out:GB']!);
  });

  it('draws no leg for a row with no clicks, and survives an empty window', () => {
    expect(routeBoard([{ key: 'x', clicks: 0 }], []).legs).toEqual([]);
    const empty = routeBoard([], []);
    expect(empty.height).toBe(ROW_H);
    expect(empty.legs).toEqual([]);
  });
});
