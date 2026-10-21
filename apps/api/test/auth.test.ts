/**
 * The guard, the two auth routes, and the auth budget, at the DOCUMENTED
 * budgets (RATE_LIMIT_AUTH=5, RATE_LIMIT_GLOBAL=240).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boot,
  call,
  DEMO,
  HERO_SLUG,
  loadSeed,
  newAuthor,
  randomAddress,
  type Harness,
} from './support';

let harness: Harness;
const createdEmails: string[] = [];

beforeAll(async () => {
  harness = await boot();
  await loadSeed(harness.db);
});

afterAll(async () => {
  if (createdEmails.length > 0)
    await harness.db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await harness.close();
});

describe('the global session guard', () => {
  it.each([
    ['GET', '/links'],
    ['POST', '/links'],
    ['GET', '/links/cnosuchlink00000000000000'],
    ['PATCH', '/links/cnosuchlink00000000000000'],
    ['DELETE', '/links/cnosuchlink00000000000000'],
    ['GET', '/links/cnosuchlink00000000000000/qr'],
    ['GET', '/links/cnosuchlink00000000000000/analytics'],
    ['GET', '/links/cnosuchlink00000000000000/live'],
    ['GET', '/live'],
  ])('refuses %s %s with no token', async (method, path) => {
    const reply = await call(harness, method, path, { user: null });
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token signed with another secret, without saying which half was wrong', async () => {
    const reply = await call(harness, 'GET', '/links', {
      user: DEMO,
      secret: 'a-completely-different-secret-value',
    });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'That token was not accepted.',
    });
  });

  it("admits a token this secret minted, and lists that user's links", async () => {
    const reply = await call<{ items: Array<{ slug: string; status: string }> }>(
      harness,
      'GET',
      '/links',
      { user: DEMO },
    );
    expect(reply.status).toBe(200);
    // Content, not the status: the seeded slugs only a working query returns.
    expect(reply.body.items.map((l) => l.slug).sort()).toEqual(
      ['beta-invite', 'docs', 'k7Qm2Xa', HERO_SLUG, 'old-promo', 'webinar-oct'].sort(),
    );
  });

  it('leaves /health public and has it really ask both dependencies', async () => {
    const reply = await call<{ status: string; checks: Array<{ name: string; status: string }> }>(
      harness,
      'GET',
      '/health',
      { user: null },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual([
      'postgres:ok',
      'redis:ok',
    ]);
  });
});

describe('sign up and sign in', () => {
  it('creates an account and signs into it', async () => {
    const email = `probe-${String(Date.now())}@links.test`;
    createdEmails.push(email);
    const created = await call<{ id: string }>(harness, 'POST', '/auth/sign-up', {
      user: null,
      body: { email, name: 'A Probe', password: 'a-long-enough-password' },
    });
    expect(created.status).toBe(201);
    const signedIn = await call<{ id: string }>(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email, password: 'a-long-enough-password' },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.id).toBe(created.body.id);
  });

  it('refuses a second account on one address, by constraint name (the real Prisma error shape)', async () => {
    const reply = await call(harness, 'POST', '/auth/sign-up', {
      user: null,
      body: { email: DEMO.email, name: 'Not Morgan', password: 'a-long-enough-password' },
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('answers a wrong password exactly as it answers an unknown address', async () => {
    const wrong = await call(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email: DEMO.email, password: 'not-the-right-password' },
    });
    const unknown = await call(harness, 'POST', '/auth/sign-in', {
      user: null,
      body: { email: 'nobody-at-all@links.test', password: 'not-the-right-password' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe('the auth budget', () => {
  it('limits sign-in per address at the documented 5/min, and does NOT limit the rest of the API', async () => {
    const address = randomAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const reply = await call(harness, 'POST', '/auth/sign-in', {
        user: null,
        address,
        body: { email: 'nobody@links.test', password: 'wrong-password-123' },
      });
      statuses.push(reply.status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);

    // The regression this pins: with an unscoped named throttler, the 5/min
    // auth budget applied to every route. Ten list calls in a row must pass,
    // and /health must answer from the same address.
    const author = await newAuthor(harness.db, 'auth-budget');
    createdEmails.push(author.email);
    for (let i = 0; i < 10; i += 1) {
      expect((await call(harness, 'GET', '/links', { user: author, address })).status).toBe(200);
    }
    expect((await call(harness, 'GET', '/health', { user: null, address })).status).toBe(200);
  });
});
