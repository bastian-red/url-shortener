import { describe, expect, it } from 'vitest';

import { checkDestination } from './destination';

const HOSTS = ['localhost:8080', 'localhost:3000'];

describe('checkDestination', () => {
  it('accepts http and https and returns the normalised href', () => {
    expect(checkDestination('https://Example.COM/Path?q=1#x', HOSTS)).toEqual({
      ok: true,
      url: 'https://example.com/Path?q=1#x',
    });
    expect(checkDestination('http://example.com', HOSTS)).toEqual({
      ok: true,
      url: 'http://example.com/',
    });
  });

  it('assumes https for a bare host, which is what people paste', () => {
    expect(checkDestination('example.com/page', HOSTS)).toEqual({
      ok: true,
      url: 'https://example.com/page',
    });
  });

  it('turns an IDN into punycode', () => {
    const result = checkDestination('https://ÉXAMPLE.com/', HOSTS);
    expect(result).toEqual({ ok: true, url: 'https://xn--xample-9ua.com/' });
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<script>', 'scheme'],
    ['ftp://example.com/file', 'scheme'],
    ['https://paypal.com@evil.example/', 'credentials'],
    ['https://user:pass@example.com/', 'credentials'],
    ['https://', 'unparseable'],
    ['http://localhost:8080/aB3xK9q', 'self_reference'],
    ['http://LOCALHOST:3000/links', 'self_reference'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too_long'],
  ])('refuses %s as %s', (input, issue) => {
    const result = checkDestination(input, HOSTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toBe(issue);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it('does not treat a different port on the same host as a self reference', () => {
    expect(checkDestination('http://localhost:9999/', HOSTS).ok).toBe(true);
  });
});
