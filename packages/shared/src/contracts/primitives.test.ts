import { describe, expect, it } from 'vitest';

import { slugSchema } from './primitives';

describe('slugSchema', () => {
  it('accepts generated base62 slugs and readable custom ones', () => {
    for (const good of ['aB3xK9q', 'launch-2026', 'spring_sale', 'Q4r']) {
      expect(slugSchema.safeParse(good).success, good).toBe(true);
    }
  });

  it('is case-sensitive: both cases are valid and distinct values', () => {
    expect(slugSchema.parse('AbC')).toBe('AbC');
    expect(slugSchema.parse('abc')).toBe('abc');
  });

  it('refuses anything a proxy could normalise into another path', () => {
    for (const bad of [
      'ab',
      '-lead',
      '_lead',
      'a/b',
      '../etc',
      'a.b',
      'a%2F',
      'x'.repeat(65),
      'sp ace',
      'ñandu',
    ]) {
      expect(slugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
