import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractTokens, resolve, stripCssComments } from './contrast';

/**
 * The identity lock: "the route map". Sky-chart paper and route red by day, a
 * night-flight navy by night, Jost / Overpass / Overpass Mono, 7px corners.
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
  light: { '--bg': '#dce8f7', '--accent': '#b50f2b', '--radius': '7px' },
  dark: { '--bg': '#0b1a35', '--accent': '#ff6b7d', '--radius': '7px' },
} as const;

const FONTS = ['Jost', 'Overpass', 'Overpass_Mono'];

/**
 * The faces `layout.tsx` loads, read the way `web/scripts/identity-distinct.mjs` reads them: the
 * names in a `next/font/google` import, plus the `<Face>` of every `./fonts/<Face>/` path a
 * `next/font/local` call points at.
 */
function importedFaces(): string[] {
  const faces = new Set<string>();
  const google = /import\s*\{([^}]*)\}\s*from\s*'next\/font\/google'/.exec(layout);
  for (const name of google?.[1]?.split(',') ?? []) if (name.trim()) faces.add(name.trim());
  for (const m of layout.matchAll(/'\.\/fonts\/([A-Za-z0-9_]+)\//g)) faces.add(m[1]!);
  if (faces.size === 0) throw new Error('layout.tsx loads no typeface the identity checks can see');
  return [...faces].sort();
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

  it('self-hosts every face, with its licence beside it, and fetches nothing from Google', () => {
    // project010 found Turbopack's Google-font resolver failing intermittently on CI.
    expect(layout).not.toMatch(/from\s*['"]next\/font\/google['"]/u);
    for (const face of FONTS) {
      const dir = join(APP, 'fonts', face);
      const files = readdirSync(dir);
      expect(files.filter((f) => f.endsWith('.woff2')), `${face} woff2`).not.toHaveLength(0);
      expect(readFileSync(join(dir, 'OFL.txt'), 'utf8'), `${face} licence`).toMatch(/SIL Open Font License/u);
    }
  });

  it('wires each face to the variable the stylesheet reads', () => {
    for (const variable of ['--font-display', '--font-ui', '--font-mono']) {
      expect(layout).toContain(`variable: '${variable}'`);
    }
  });

  it('paints the browser chrome with the canvas in each scheme', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const bg = resolve(SURFACES[scheme], '--bg').toLowerCase();
      expect(layout, `${scheme} theme-color`).toContain(
        `{ media: '(prefers-color-scheme: ${scheme})', color: '${bg}' }`,
      );
    }
  });

  it('does not reintroduce the shared signal red or the banned generator tics', () => {
    expect([...globals.matchAll(/#ff0000|#f00\b/gi)]).toHaveLength(0);
    expect(globals).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
  });
});

/**
 * What the rest of the portfolio already spent (001-008, 010). The cross-repo script
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
    '#e1f7f2',
    '#021409',
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
    '#5a4590',
    '#b9a6ee',
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
    'Space_Grotesk',
    'Atkinson_Hyperlegible_Next',
    'Fira_Code',
  ],
  radii: ['10px', '2px', '6px', '4px', '12px', '3px', '16px', '5px'],
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
