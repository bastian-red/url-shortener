import { describe, expect, it } from 'vitest';

import { linkStatus, type StatusInput } from './link-status';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const base: StatusInput = { disabled: false, expiresAt: null, maxClicks: null, redirects: 0 };

describe('linkStatus', () => {
  it('is active with no limits', () => {
    expect(linkStatus(base, NOW)).toBe('active');
  });

  it('is expired at the exact expiry instant, not one millisecond later', () => {
    expect(linkStatus({ ...base, expiresAt: NOW }, NOW)).toBe('expired');
    expect(linkStatus({ ...base, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe('expiring');
  });

  it('is expiring inside 24 hours and active beyond', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(linkStatus({ ...base, expiresAt: new Date(NOW.getTime() + day) }, NOW)).toBe('expiring');
    expect(linkStatus({ ...base, expiresAt: new Date(NOW.getTime() + day + 1) }, NOW)).toBe(
      'active',
    );
  });

  it('reaches its limit when redirects equal maxClicks', () => {
    expect(linkStatus({ ...base, maxClicks: 3, redirects: 2 }, NOW)).toBe('active');
    expect(linkStatus({ ...base, maxClicks: 3, redirects: 3 }, NOW)).toBe('limit_reached');
  });

  it('ranks disabled over expired over limit_reached', () => {
    const all = { disabled: true, expiresAt: NOW, maxClicks: 1, redirects: 5 };
    expect(linkStatus(all, NOW)).toBe('disabled');
    expect(linkStatus({ ...all, disabled: false }, NOW)).toBe('expired');
    expect(linkStatus({ ...all, disabled: false, expiresAt: null }, NOW)).toBe('limit_reached');
  });
});
