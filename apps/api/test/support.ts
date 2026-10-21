/**
 * Shared plumbing for the API's integration lane.
 *
 * The Nest application is built from the real `AppModule` and listens on an
 * ephemeral port, so every request below travels the whole stack: the session
 * guard, the throttler, the pipes, the filter, Prisma, Postgres, Redis. Nothing
 * is mocked, because what this lane exists to catch -- a guard that is not
 * default-closed, an upsert that is not idempotent, a trigger that is missing --
 * is a failure of the wiring rather than of a pure function, and the pure
 * functions already have their own tests.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createPrismaClient, type PrismaClient } from '@links/db';
import type { SessionUser } from '@links/shared';
import { mintServiceToken } from '@links/shared/server';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';

import { AppModule } from '../src/app.module';

export const AUTH_SECRET = required('AUTH_SECRET', process.env.AUTH_SECRET);
export const DATABASE_URL = required('DATABASE_URL', process.env.DATABASE_URL);
export const REDIS_URL = required('REDIS_URL', process.env.REDIS_URL);

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through ./scripts/integration.sh.`);
  }
  return value;
}

export interface Harness {
  readonly app: INestApplication;
  readonly base: string;
  readonly db: PrismaClient;
  readonly redis: Redis;
  close(): Promise<void>;
}

export async function boot(): Promise<Harness> {
  // The same body parser and proxy trust main.ts sets up, so the harness runs
  // the program that ships.
  const app = await NestFactory.create<
    INestApplication & { set(key: string, value: unknown): void }
  >(AppModule, {
    logger: ['error'],
  });
  app.set('trust proxy', 1);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer() as { address(): AddressInfo | string | null };
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the API did not bind a port');

  const db = createPrismaClient({ url: DATABASE_URL });
  const redis = new Redis(REDIS_URL);
  return {
    app,
    base: `http://127.0.0.1:${String(address.port)}`,
    db,
    redis,
    close: async () => {
      await db.$disconnect();
      redis.disconnect();
      await app.close();
    },
  };
}

/** The seeded author, id filled in by `loadSeed`. Read out of the seed, never retyped. */
export const DEMO: SessionUser = { id: '', email: 'demo@links.test', name: 'Morgan Reyes' };
export const HERO_SLUG = 'launch';

export async function loadSeed(db: PrismaClient): Promise<{ heroId: string }> {
  const user = await db.user.findUniqueOrThrow({
    where: { email: DEMO.email },
    select: { id: true },
  });
  DEMO.id = user.id;
  const hero = await db.link.findUniqueOrThrow({
    where: { slug: HERO_SLUG },
    select: { id: true },
  });
  return { heroId: hero.id };
}

/**
 * A fresh author for a test that must not see the seed's rows. Also what keeps
 * this lane at the DOCUMENTED budgets: signed-in calls are counted per user, so
 * a user per suite never borrows another suite's minute.
 */
export async function newAuthor(db: PrismaClient, label: string): Promise<SessionUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@links.test`;
  const row = await db.user.create({
    data: { email, name: label, passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  return { id: row.id, email, name: label };
}

/** The redirect service and the click worker this lane starts (scripts/integration.sh). */
export const REDIRECT_URL = required('REDIRECT_TEST_URL', process.env.REDIRECT_TEST_URL);

/** One visit to a short link, as a browser behind one proxy hop would send it. */
export async function visit(
  slug: string,
  options: { address?: string; userAgent?: string; referer?: string; method?: string } = {},
): Promise<Response> {
  return fetch(`${REDIRECT_URL}/${slug}`, {
    method: options.method ?? 'GET',
    redirect: 'manual',
    headers: {
      'x-forwarded-for': options.address ?? randomAddress(),
      'user-agent':
        options.userAgent ??
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ...(options.referer === undefined ? {} : { referer: options.referer }),
    },
  });
}

/** Poll until `check` returns a value, or fail after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly text: string;
}

/** A private address, random per call, so per-address budgets never leak between tests. */
export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * One request.
 *
 * The token is minted per call rather than cached: a cached one works for two
 * minutes and then fails for the rest of the run, and that looks like
 * flakiness. `user: null` sends no `Authorization` header, which is how the
 * default-closed guard and the public routes are exercised. Anonymous calls get
 * a fresh `x-forwarded-for` each unless `address` pins one, so per-address
 * budgets do not leak between tests.
 */
export async function call<T = unknown>(
  harness: Harness,
  method: string,
  path: string,
  options: { user?: SessionUser | null; body?: unknown; secret?: string; address?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.address ?? randomAddress() };
  if (options.user !== null && options.user !== undefined) {
    headers.authorization = `Bearer ${mintServiceToken(options.user, options.secret ?? AUTH_SECRET)}`;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, headers: response.headers, text };
}

/** An Authorization header value for `user`, for the few calls that need raw fetch (binary bodies). */
export function bearer(user: SessionUser): string {
  return `Bearer ${mintServiceToken(user, AUTH_SECRET)}`;
}
