import { describe, expect, it } from 'vitest';

import { heatStep, niceMax, sparkPath } from './spark';

describe('sparkPath', () => {
  it('pins the baseline at zero and spans the width', () => {
    expect(sparkPath([0, 5, 10], 100, 22)).toBe('M0.0,21.0 L50.0,11.0 L100.0,1.0');
  });

  it('draws a flat line along the bottom for no clicks, not a divide-by-zero', () => {
    expect(sparkPath([0, 0], 10, 12)).toBe('M0.0,11.0 L10.0,11.0');
    expect(sparkPath([], 10, 12)).toBe('');
  });
});

describe('niceMax', () => {
  it.each([
    [0, 4],
    [3, 4],
    [37, 40],
    [101, 120],
    [1234, 1600],
    [9000, 10000],
  ])('%d -> %d', (value, expected) => {
    expect(niceMax(value)).toBe(expected);
    expect(niceMax(value) % 4).toBe(0);
  });
});

describe('heatStep', () => {
  it('reserves step 0 for no clicks at all and puts the peak in the top step', () => {
    expect(heatStep(0, 100, 5)).toBe(0);
    expect(heatStep(1, 100, 5)).toBe(1);
    expect(heatStep(100, 100, 5)).toBe(5);
    expect(heatStep(41, 100, 5)).toBe(3);
  });
});
