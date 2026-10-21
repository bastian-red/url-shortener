import { describe, expect, it } from 'vitest';

import {
  DomainError,
  ERROR_CODES,
  HTTP_STATUS,
  codeForHttpStatus,
  httpStatusForCode,
  isDomainError,
} from './errors';

describe('DomainError', () => {
  it('survives instanceof, which every catch block depends on', () => {
    const error = new DomainError('NOT_FOUND', 'gone');
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(isDomainError(error)).toBe(true);
    expect(isDomainError(new Error('gone'))).toBe(false);
  });

  it('carries the code as a property, so nothing matches on prose', () => {
    expect(new DomainError('CONFLICT', 'clash').code).toBe('CONFLICT');
  });

  it('carries structured details when a client has something to act on', () => {
    const issues = [{ code: 'backward_jump', fieldId: 'f_aaaaaaaa' }];
    expect(new DomainError('UNPROCESSABLE', 'no', issues).details).toBe(issues);
    expect(new DomainError('NOT_FOUND', 'no').details).toBeUndefined();
  });
});

describe('HTTP_STATUS', () => {
  // Exhaustive over the vocabulary rather than by example: a code added to
  // ERROR_CODES and forgotten here would answer 500 for a client mistake.
  it.each(ERROR_CODES)('has a status for %s', (code) => {
    expect(typeof HTTP_STATUS[code]).toBe('number');
  });

  it('covers exactly the vocabulary, with nothing extra', () => {
    expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  /**
   * The three that are deliberately not the obvious status. 404-for-not-yours is
   * a security property (it hides which link ids exist); 410 tells a visitor
   * the link was real but has expired; 422 separates "the domain refuses this
   * edit" from "your request was malformed".
   */
  it('answers 404 for not yours, 410 for expired, 422 for a refused edit', () => {
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS.GONE).toBe(410);
    expect(HTTP_STATUS.FORBIDDEN).toBe(403);
    expect(HTTP_STATUS.UNPROCESSABLE).toBe(422);
  });

  it('inverts back to the code that produced it', () => {
    expect(codeForHttpStatus(401)).toBe('UNAUTHENTICATED');
    expect(codeForHttpStatus(410)).toBe('GONE');
    // A status no code claims. The filter falls back rather than guessing.
    expect(codeForHttpStatus(429)).toBeNull();
    expect(codeForHttpStatus(200)).toBeNull();
  });

  it('is injective, or the inverse would silently pick one', () => {
    // Two codes sharing a status would make `codeForHttpStatus` answer with
    // whichever was declared last, and the client would branch on the wrong one.
    const statuses = ERROR_CODES.map((code) => HTTP_STATUS[code]);
    expect(new Set(statuses).size).toBe(ERROR_CODES.length);
  });

  it('falls back to 500 for a string that is not a code', () => {
    expect(httpStatusForCode('NOT_FOUND')).toBe(404);
    expect(httpStatusForCode('TEAPOT')).toBe(500);
    // Prototype keys are not codes. `hasOwnProperty` rather than `in`, so
    // `httpStatusForCode('toString')` is 500 and not a crash.
    expect(httpStatusForCode('toString')).toBe(500);
    expect(httpStatusForCode('__proto__')).toBe(500);
  });
});
