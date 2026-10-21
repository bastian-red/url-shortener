import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config/config';
import { Budget, budgetOf, throttlers, trackerFor } from './throttle';

@Controller()
class Probe {
  @Budget('auth')
  @Get()
  signIn(): void {}

  @Budget('create')
  @Get()
  create(): void {}

  @Get()
  list(): void {}
}

function contextFor(handler: keyof Probe): ExecutionContext {
  return {
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
  } as unknown as ExecutionContext;
}

const CONFIG = { rateLimitGlobal: 240, rateLimitAuth: 5, rateLimitCreate: 30 } as ApiConfig;

describe('throttlers', () => {
  const [general, auth, create] = throttlers(CONFIG);

  it('applies the auth budget to auth routes ONLY', () => {
    // The bug this file exists to prevent: in @nestjs/throttler v6 every named
    // throttler applies to every route unless it skips. Without `skipIf`, the
    // five-per-minute auth budget would limit the link list too.
    expect(auth!.skipIf!(contextFor('signIn'))).toBe(false);
    expect(auth!.skipIf!(contextFor('list'))).toBe(true);
    expect(auth!.skipIf!(contextFor('create'))).toBe(true);
  });

  it('applies the create budget to link creation only', () => {
    expect(create!.skipIf!(contextFor('create'))).toBe(false);
    expect(create!.skipIf!(contextFor('list'))).toBe(true);
    expect(create!.skipIf!(contextFor('signIn'))).toBe(true);
  });

  it('applies the general budget everywhere', () => {
    expect(general!.skipIf).toBeUndefined();
    expect(budgetOf(contextFor('list'))).toBeUndefined();
  });

  it('keys a counter by budget and caller, not by route', () => {
    // Per-route keys would let a flood split itself across sign-in and sign-up
    // and get twice the budget.
    const key = auth!.generateKey!(contextFor('signIn'), 'ip:1.2.3.4', 'auth');
    expect(key).toBe('throttle:auth:ip:1.2.3.4');
  });
});

describe('trackerFor', () => {
  it('counts signed-in calls per user, because they all arrive from the web server', () => {
    const user = { id: 'cuser000000000000000001', email: 'a@b.co', name: 'A' };
    expect(trackerFor({ user, ip: '10.0.0.5' })).toBe('user:cuser000000000000000001');
  });

  it('counts anonymous calls per address', () => {
    expect(trackerFor({ user: undefined, ip: '203.0.113.9' })).toBe('ip:203.0.113.9');
  });
});
