/**
 * The Go redirect service renders its own 404/410/429 pages (real status codes
 * for crawlers), with the six colour tokens copied into the template because it
 * cannot import this stylesheet. This holds the copy to the original: if the
 * palette changes here and not there, the commit fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractTokens, stripCssComments } from './contrast';
import { SURFACES } from './identity.test';

const template = stripCssComments(
  readFileSync(
    join(__dirname, '..', '..', '..', 'services', 'redirect', 'internal', 'pages', 'page.html'),
    'utf8',
  ),
);
const TOKENS = ['--bg', '--surface', '--text', '--muted', '--accent', '--border'] as const;

describe('redirect service error pages', () => {
  const light = extractTokens(template, ':root');
  const dark = extractTokens(template, '@media (prefers-color-scheme: dark)');

  it.each(TOKENS)('light %s matches globals.css', (token) => {
    expect(light[token]).toBe(SURFACES.light[token]);
  });

  it.each(TOKENS)('dark %s matches globals.css', (token) => {
    expect(dark[token]).toBe(SURFACES.dark[token]);
  });
});
