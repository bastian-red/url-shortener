/**
 * Rate-limit budgets, scoped explicitly.
 *
 * `@nestjs/throttler` v6 applies EVERY named throttler to EVERY route unless a
 * route skips it, and by default keys each counter per route handler. Measured
 * against `ThrottlerGuard.canActivate` in 6.5.0: the loop runs all throttlers in
 * the list, and only `@SkipThrottle({ name: true })` or a `skipIf` stops one.
 * So a strict `auth` budget registered next to the general one, and then merely
 * "selected" with `@Throttle({ auth: {} })` on two routes, in fact limits every
 * route to the auth number. A sibling project shipped exactly that.
 *
 * Here each special budget has a `skipIf` that reads the route's `@Budget()`
 * metadata, so it applies to the routes that ask for it and to nothing else.
 *
 * **What a counter is keyed by.** Signed-in calls all arrive from the web
 * server, so the address is the same for every author; keying them by address
 * would make one busy author throttle everybody. They are keyed by the user id
 * in the verified token instead, which is why `SessionGuard` runs BEFORE the
 * throttler (`app.module.ts`). Anonymous calls (sign-in, sign-up) are keyed by
 * address: the web app forwards the browser's address in
 * `x-forwarded-for` and `trust proxy` is one hop. Counters are per budget, not
 * per route, so splitting a flood across two routes buys nothing.
 */
import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerOptions } from '@nestjs/throttler';
import type { Request } from 'express';

import type { ApiConfig } from '../config/config';
import type { RequestWithUser } from './session.guard';

export const BUDGET = 'links:budget';

export type BudgetName = 'auth' | 'create';

/** Opt a route into a special budget, on top of the general one. */
export const Budget = (name: BudgetName): MethodDecorator => SetMetadata(BUDGET, name);

// Reflector is stateless; a module-level instance reads the same metadata the
// injected one would, and `skipIf` is called without access to the container.
const reflector = new Reflector();

export function budgetOf(context: ExecutionContext): BudgetName | undefined {
  return reflector.getAllAndOverride<BudgetName | undefined>(BUDGET, [
    context.getHandler(),
    context.getClass(),
  ]);
}

export function trackerFor(request: Pick<RequestWithUser, 'user' | 'ip'>): string {
  if (request.user !== undefined) return `user:${request.user.id}`;
  return `ip:${request.ip ?? 'unknown'}`;
}

const MINUTE = 60_000;

export function throttlers(config: ApiConfig): ThrottlerOptions[] {
  const common = {
    ttl: MINUTE,
    getTracker: (request: Record<string, unknown>) =>
      trackerFor(request as unknown as Request & RequestWithUser),
    generateKey: (_context: ExecutionContext, tracker: string, name: string) =>
      `throttle:${name}:${tracker}`,
  };
  return [
    { ...common, name: 'default', limit: config.rateLimitGlobal },
    {
      ...common,
      name: 'auth',
      limit: config.rateLimitAuth,
      skipIf: (context) => budgetOf(context) !== 'auth',
    },
    {
      ...common,
      name: 'create',
      limit: config.rateLimitCreate,
      skipIf: (context) => budgetOf(context) !== 'create',
    },
  ];
}
