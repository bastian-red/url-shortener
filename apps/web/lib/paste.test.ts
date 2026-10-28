import { describe, expect, it } from 'vitest';

import { looksLikeUrl } from './paste';

describe('paste anywhere', () => {
  it.each([
    'https://example.com/a/very/long/path?utm_source=x',
    'http://example.com',
    'example.com/blog/spring-launch',
    'sub.example.co.uk',
  ])('shortens %s', (text) => {
    expect(looksLikeUrl(text)).toBe(true);
  });

  it.each([
    '',
    'hello world',
    'just-a-word',
    'https://',
    'ftp://example.com/file',
    'see https://example.com for details',
    'https://example.com/notes from the meeting',
    `https://example.com/${'a'.repeat(2050)}`,
  ])('ignores %j', (text) => {
    expect(looksLikeUrl(text)).toBe(false);
  });
});
