import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { entriesOf, fieldsToObject, parseEntry } from './stream';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'contracts', 'fixtures', 'click-event.json'),
    'utf8',
  ),
) as Record<string, string>;
const flat = Object.entries(fixture).flat();

describe('parseEntry', () => {
  it('reads the golden fixture the Go service is tested against', () => {
    const parsed = parseEntry(['1792584000000-0', flat]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.event.slug).toBe('launch');
  });

  it('dead-letters an entry from a future contract version, with the reason', () => {
    const parsed = parseEntry(['1-0', Object.entries({ ...fixture, v: '2' }).flat()]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('v');
  });

  it('dead-letters an entry that was trimmed away (no fields)', () => {
    expect(parseEntry(['1-0', []]).ok).toBe(false);
  });
});

describe('entriesOf', () => {
  it('flattens an XREADGROUP reply and treats a timeout as empty', () => {
    expect(entriesOf(null)).toEqual([]);
    expect(
      entriesOf([
        [
          'clicks',
          [
            ['1-0', ['a', 'b']],
            ['2-0', null],
          ],
        ],
      ]),
    ).toEqual([
      ['1-0', ['a', 'b']],
      ['2-0', []],
    ]);
  });

  it('fieldsToObject pairs keys and values', () => {
    expect(fieldsToObject(['a', '1', 'b', '2'])).toEqual({ a: '1', b: '2' });
  });
});
