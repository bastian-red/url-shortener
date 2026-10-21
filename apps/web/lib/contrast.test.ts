/**
 * Every colour pair this app paints, against WCAG AA, in both schemes, parsed
 * from the real stylesheet. Never from a copy of the palette:
 * a table of hexes in TypeScript would pass forever while the CSS said
 * something else.
 */
import { describe, expect, it } from 'vitest';

import { AA_NORMAL, AA_UI, greyscale, ratio, resolve } from './contrast';
import { SURFACES } from './identity.test';

const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;
/** Everything that is ever text: body, secondary, links, errors, and the three status words. */
const TEXT_ON_BACKGROUNDS = [
  '--text',
  '--muted',
  '--accent',
  '--danger',
  '--ok',
  '--warn',
] as const;
const PAIRS = [
  ['--accent-ink', '--accent'], // primary button
  ['--accent-ink', '--accent-hover'], // primary button, hovered
  ['--text', '--accent-soft'], // created strip, notices, the live +1
  ['--accent', '--accent-soft'],
  ['--danger', '--danger-soft'], // form errors
  ['--text', '--series-1-soft'], // the brush scope strip
] as const;

const schemes = Object.entries(SURFACES);

describe('text clears AA everywhere it is painted', () => {
  for (const [name, palette] of schemes) {
    for (const foreground of TEXT_ON_BACKGROUNDS) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${foreground} on ${background}`, () => {
          const value = ratio(resolve(palette, foreground), resolve(palette, background));
          expect(
            value,
            `${name} ${foreground} on ${background} is ${String(value)}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
    for (const [foreground, background] of PAIRS) {
      it(`${name}: ${foreground} on ${background}`, () => {
        const value = ratio(resolve(palette, foreground), resolve(palette, background));
        expect(
          value,
          `${name} ${foreground} on ${background} is ${String(value)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

describe('control edges, the focus ring and chart marks clear 3:1', () => {
  for (const [name, palette] of schemes) {
    for (const edge of ['--border', '--accent', '--series-1'] as const) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${edge} on ${background}`, () => {
          expect(
            ratio(resolve(palette, edge), resolve(palette, background)),
          ).toBeGreaterThanOrEqual(AA_UI);
        });
      }
    }
  }
});

describe('the accent and the danger red collapse, which is why errors carry ⚠ and words', () => {
  for (const [name, palette] of schemes) {
    it(`${name}: under 1.3:1 in colour and under 3:1 in greyscale`, () => {
      const accent = resolve(palette, '--accent');
      const danger = resolve(palette, '--danger');
      expect(ratio(accent, danger)).toBeLessThan(1.3);
      expect(ratio(greyscale(accent), greyscale(danger))).toBeLessThan(AA_UI);
    });
  }
});

describe('the heat ramp is monotonic, so "darker means more" holds in both schemes', () => {
  for (const [name, palette] of schemes) {
    it(`${name}: each step contrasts more with the surface than the last`, () => {
      const surface = resolve(palette, '--surface');
      const steps = [1, 2, 3, 4, 5].map((s) =>
        ratio(resolve(palette, `--heat-${String(s)}`), surface),
      );
      for (let i = 1; i < steps.length; i += 1)
        expect(steps[i]!, `step ${String(i + 1)}`).toBeGreaterThan(steps[i - 1]!);
    });
  }
});
