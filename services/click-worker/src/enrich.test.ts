import { describe, expect, it } from 'vitest';

import type { ClickEvent } from '@links/shared';

import { classify, enrich, hourOf, referrerHost, visitorHash } from './enrich';

const SECRET = 'test-secret-at-least-16-chars';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const event = (over: Partial<ClickEvent> = {}): ClickEvent => ({
  v: '1',
  link: 'cm9link',
  slug: 'launch',
  ts: String(Date.UTC(2026, 9, 21, 14, 37, 12, 345)),
  ip: '81.2.69.160',
  ua: IPHONE,
  ref: 'https://www.t.co/abc',
  lang: 'en-GB',
  ...over,
});

describe('classify', () => {
  it.each([
    [IPHONE, 'mobile', 'Mobile Safari', 'iOS', false],
    [DESKTOP_CHROME, 'desktop', 'Chrome', 'Windows', false],
    [IPAD, 'tablet', 'Mobile Safari', 'iOS', false],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'bot', '', '', true],
    [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'bot',
      '',
      '',
      true,
    ],
    ['curl/8.14.1', 'bot', '', '', true],
    ['', 'bot', '', '', true],
  ])('%s -> %s', (ua, device, browser, os, isBot) => {
    const result = classify(ua);
    expect(result.device).toBe(device);
    expect(result.isBot).toBe(isBot);
    if (!isBot) {
      expect(result.browser).toBe(browser);
      expect(result.os).toBe(os);
    }
  });
});

describe('referrerHost', () => {
  it.each([
    ['https://www.t.co/abc', 't.co'],
    ['https://News.YCombinator.com/item?id=1', 'news.ycombinator.com'],
    ['', ''],
    ['android-app://com.slack', ''],
    ['not a url', ''],
  ])('%s -> %s', (ref, host) => {
    expect(referrerHost(ref)).toBe(host);
  });
});

describe('visitorHash', () => {
  const day = new Date('2026-10-21T10:00:00Z');

  it('is 16 bytes and stable within a day', () => {
    const a = visitorHash(SECRET, day, '1.2.3.4', IPHONE);
    const b = visitorHash(SECRET, new Date('2026-10-21T23:59:59Z'), '1.2.3.4', IPHONE);
    expect(a).toHaveLength(16);
    expect(a.equals(b)).toBe(true);
  });

  it('rotates at UTC midnight, so it cannot follow a person across days', () => {
    const a = visitorHash(SECRET, day, '1.2.3.4', IPHONE);
    const b = visitorHash(SECRET, new Date('2026-10-22T00:00:00Z'), '1.2.3.4', IPHONE);
    expect(a.equals(b)).toBe(false);
  });

  it('depends on the secret, the address and the user agent', () => {
    const base = visitorHash(SECRET, day, '1.2.3.4', IPHONE);
    expect(base.equals(visitorHash('another-secret-16chars', day, '1.2.3.4', IPHONE))).toBe(false);
    expect(base.equals(visitorHash(SECRET, day, '1.2.3.5', IPHONE))).toBe(false);
    expect(base.equals(visitorHash(SECRET, day, '1.2.3.4', DESKTOP_CHROME))).toBe(false);
  });
});

describe('enrich', () => {
  const geo = (ip: string) =>
    ip === '81.2.69.160' ? { country: 'GB', region: 'England', city: 'London' } : null;

  it('produces a row with every dimension and no field that can hold the IP', () => {
    const row = enrich('1792584000000-0', event(), geo, SECRET);
    expect(row).toMatchObject({
      id: '1792584000000-0',
      linkId: 'cm9link',
      country: 'GB',
      city: 'London',
      device: 'mobile',
      referrer: 't.co',
      isBot: false,
    });
    expect(row.hour.toISOString()).toBe('2026-10-21T14:00:00.000Z');
    // SPECS outcome 7, at the function boundary: the address appears in no field.
    expect(JSON.stringify({ ...row, visitor: row.visitor.toString('hex') })).not.toContain(
      '81.2.69.160',
    );
  });

  it('records an unknown country rather than dropping the click', () => {
    expect(enrich('1-0', event({ ip: '10.0.0.1' }), geo, SECRET).country).toBe('');
    expect(enrich('1-0', event({ ip: '' }), geo, SECRET).country).toBe('');
  });
});

describe('hourOf', () => {
  it('floors to the UTC hour', () => {
    expect(hourOf(new Date('2026-10-21T14:59:59.999Z')).toISOString()).toBe(
      '2026-10-21T14:00:00.000Z',
    );
  });
});
