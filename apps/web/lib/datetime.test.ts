import { describe, expect, it } from 'vitest';

import { isoToLocal, localToIso } from './datetime';

describe('localToIso', () => {
  it("reads the wall clock in the author's offset, not the server's", () => {
    // Santiago in October is UTC-3: getTimezoneOffset() reports +180.
    expect(localToIso('2026-10-21T18:00', 180)).toBe('2026-10-21T21:00:00.000Z');
    // Berlin in October (CEST, UTC+2) reports -120.
    expect(localToIso('2026-10-21T18:00', -120)).toBe('2026-10-21T16:00:00.000Z');
  });

  it('answers null for blank or malformed input', () => {
    expect(localToIso('', 0)).toBeNull();
    expect(localToIso('tomorrow', 0)).toBeNull();
  });
});

describe('isoToLocal', () => {
  it('round-trips with localToIso in the same zone', () => {
    expect(isoToLocal('2026-10-21T21:00:00.000Z', 'America/Santiago')).toBe('2026-10-21T18:00');
    expect(isoToLocal(null, 'UTC')).toBe('');
  });
});
