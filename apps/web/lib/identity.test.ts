import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractTokens, resolve, stripCssComments } from './contrast';

/**
 * The identity lock: rose-clay paper and signal vermilion by
 * day, teal-black by night, three grotesque-and-mono faces, 8px corners.
 *
 * Read out of the real stylesheet and `app/layout.tsx`. A redesign that drifts
 * compiles, renders and passes every other test; changing the identity means
 * editing this file deliberately.
 */
const APP = join(__dirname, '..', 'app');
const globals = stripCssComments(readFileSync(join(APP, 'globals.css'), 'utf8'));
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

const DARK = '@media (prefers-color-scheme: dark)';

export const SURFACES = {
  light: extractTokens(globals, ':root'),
  dark: { ...extractTokens(globals, ':root'), ...extractTokens(globals, DARK) },
} as const;

const IDENTITY = {
  light: { '--bg': '#f6f0ee', '--accent': '#b33a12', '--radius': '8px' },
  dark: { '--bg': '#0e1517', '--accent': '#ff8a5c', '--radius': '8px' },
} as const;

const FONTS = ['Bricolage_Grotesque', 'Martian_Mono', 'Schibsted_Grotesk'];

/** The same regex `web/scripts/identity-distinct.mjs` uses. ONE import, single-quoted. */
function importedFaces(): string[] {
  const line = /import\s*\{([^}]*)\}\s*from\s*'next\/font\/google'/.exec(layout);
  if (!line) throw new Error('layout.tsx imports nothing from next/font/google');
  return line[1]!
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe('visual identity', () => {
  for (const [scheme, tokens] of Object.entries(IDENTITY)) {
    it.each(Object.entries(tokens))(`${scheme}: %s is %s`, (token, expected) => {
      const palette = SURFACES[scheme as keyof typeof SURFACES];
      const value = token === '--radius' ? palette[token] : resolve(palette, token).toLowerCase();
      expect(value).toBe(expected);
    });
  }

  it('loads exactly the faces this identity is built on', () => {
    expect(importedFaces()).toEqual(FONTS);
  });

  it('keeps the one font import in the shape the cross-repo check can parse', () => {
    expect([...layout.matchAll(/from\s*['"]next\/font\/google['"]/g)]).toHaveLength(1);
  });

  it('wires each face to the variable the stylesheet reads', () => {
    for (const variable of ['--font-display', '--font-ui', '--font-mono']) {
      expect(layout).toContain(`variable: '${variable}'`);
    }
  });

  it('does not reintroduce the shared signal red or the banned generator tics', () => {
    expect([...globals.matchAll(/#ff0000|#f00\b/gi)]).toHaveLength(0);
    expect(globals).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
  });
});

/**
 * What the rest of the portfolio already spent (001-008). The cross-repo script
 * is the authority; this is the half a single repo can check in its own gate.
 */
const SPENT = {
  canvases: [
    '#fafaf8',
    '#101319',
    '#fffdfa',
    '#f6f7f9',
    '#fbf8f3',
    '#f8fafc',
    '#f7f6fb',
    '#12111a',
    '#ecedf0',
    '#191621',
    '#f4f1e8',
    '#15191c',
    '#e4e8e0',
    '#171b17',
    '#ffffff',
    '#1b1b1d',
    '#fbf3ea',
    '#1b1714',
  ],
  accents: [
    '#4f46e5',
    '#818cf8',
    '#7a2e2e',
    '#1f6feb',
    '#0f766e',
    '#1d4ed8',
    '#6d28d9',
    '#a78bfa',
    '#a01a6d',
    '#f4a3d6',
    '#0d6b85',
    '#63c9e6',
    '#1a6b3c',
    '#6fca90',
    '#4d5c00',
    '#b9c95a',
    '#8a5a00',
    '#e6b450',
  ],
  faces: [
    'Fraunces',
    'Inter',
    'Instrument_Serif',
    'Archivo',
    'IBM_Plex_Mono',
    'Source_Serif_4',
    'IBM_Plex_Sans',
    'JetBrains_Mono',
    'Newsreader',
    'Public_Sans',
    'Roboto_Mono',
    'Sora',
    'Manrope',
    'DM_Mono',
    'Literata',
    'Figtree',
    'Azeret_Mono',
    'Spectral',
    'Karla',
    'Red_Hat_Mono',
    'Lora',
    'Hanken_Grotesk',
    'Geist_Mono',
  ],
  radii: ['10px', '2px', '6px', '4px', '12px', '3px', '16px'],
} as const;

describe('no two projects share an identity', () => {
  it.each(Object.keys(SURFACES))(
    '%s: the canvas and the accent are this project alone',
    (scheme) => {
      const palette = SURFACES[scheme as keyof typeof SURFACES];
      expect(SPENT.canvases).not.toContain(resolve(palette, '--bg').toLowerCase());
      expect(SPENT.accents).not.toContain(resolve(palette, '--accent').toLowerCase());
    },
  );

  it('loads no typeface another project already uses', () => {
    expect(
      importedFaces().filter((face) => (SPENT.faces as readonly string[]).includes(face)),
    ).toEqual([]);
  });

  it('uses a primary radius no sibling uses', () => {
    expect(SPENT.radii as readonly string[]).not.toContain(SURFACES.light['--radius']);
  });
});
