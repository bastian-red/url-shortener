/**
 * Link CRUD through the real module graph, and the write-through cache it
 * depends on, observed both in Redis and through the running redirect service
 * (SPECS outcome 5: an edit takes effect on the very next request).
 */
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Link, SessionUser } from '@links/shared';

import { bearer, boot, call, newAuthor, randomAddress, visit, type Harness } from './support';

let harness: Harness;
let owner: SessionUser;
let stranger: SessionUser;

beforeAll(async () => {
  harness = await boot();
  owner = await newAuthor(harness.db, 'links-owner');
  stranger = await newAuthor(harness.db, 'links-stranger');
});

afterAll(async () => {
  await harness.db.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
  await harness.close();
});

const create = (body: unknown, user: SessionUser = owner) =>
  call<Link>(harness, 'POST', '/links', { user, body });

describe('create', () => {
  it('generates a 7-character slug and writes the redirect cache before answering', async () => {
    const reply = await create({ url: 'https://example.com/a', title: 'A' });
    expect(reply.status).toBe(201);
    expect(reply.body.slug).toMatch(/^[0-9A-Za-z]{7}$/u);
    expect(reply.body.shortUrl).toBe(`${process.env.SHORT_BASE_URL ?? ''}/${reply.body.slug}`);
    expect(reply.body.status).toBe('active');
    const cached = await harness.redis.hgetall(`l:${reply.body.slug}`);
    expect(cached).toEqual({
      id: reply.body.id,
      url: 'https://example.com/a',
      exp: '0',
      max: '0',
      dis: '0',
      nf: '0',
    });
  });

  it('accepts a bare host and normalises it', async () => {
    const reply = await create({ url: 'Example.COM/Page' });
    expect(reply.status).toBe(201);
    expect(reply.body.url).toBe('https://example.com/Page');
  });

  it('takes a custom slug, and refuses the same slug twice with a 409 (the real unique-violation shape)', async () => {
    const slug = `camp-${String(Date.now()).slice(-8)}`;
    expect((await create({ url: 'https://example.com/c', slug })).status).toBe(201);
    const again = await create({ url: 'https://example.com/d', slug }, stranger);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT' });
  });

  it.each([
    ['a reserved slug', { url: 'https://example.com', slug: 'Health' }, 400],
    ['a javascript: URL', { url: 'javascript:alert(1)' }, 400],
    ['credentials in the URL', { url: 'https://paypal.com@evil.example/' }, 400],
    [
      'a link to the short domain itself',
      { url: `${process.env.SHORT_BASE_URL ?? ''}/abc1234` },
      400,
    ],
    [
      'an expiry in the past',
      { url: 'https://example.com', expiresAt: '2020-01-01T00:00:00.000Z' },
      400,
    ],
    ['a zero click limit', { url: 'https://example.com', maxClicks: 0 }, 400],
  ])('refuses %s', async (_name, body, status) => {
    const reply = await create(body);
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ code: 'INVALID' });
  });
});

describe('ownership', () => {
  it("answers 404, not 403, for somebody else's link, on every verb", async () => {
    const mine = await create({ url: 'https://example.com/private' });
    for (const [method, path, body] of [
      ['GET', `/links/${mine.body.id}`, undefined],
      ['PATCH', `/links/${mine.body.id}`, { disabled: true }],
      ['DELETE', `/links/${mine.body.id}`, undefined],
      ['GET', `/links/${mine.body.id}/qr`, undefined],
      [
        'GET',
        `/links/${mine.body.id}/analytics?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z`,
        undefined,
      ],
    ] as const) {
      const reply = await call(harness, method, path, { user: stranger, body });
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    // And the stranger's attempts changed nothing.
    expect((await visit(mine.body.slug)).status).toBe(302);
  });
});

describe('edits reach the redirect service on the very next request (SPECS outcome 5)', () => {
  it('a new destination, then disabled, then re-enabled, then deleted', async () => {
    const link = await create({ url: 'https://example.com/v1' });
    const slug = link.body.slug;
    let r = await visit(slug);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com/v1');

    await call(harness, 'PATCH', `/links/${link.body.id}`, {
      user: owner,
      body: { url: 'https://example.com/v2' },
    });
    r = await visit(slug);
    expect(r.headers.get('location')).toBe('https://example.com/v2');

    await call(harness, 'PATCH', `/links/${link.body.id}`, {
      user: owner,
      body: { disabled: true },
    });
    r = await visit(slug);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain('Turned off');

    await call(harness, 'PATCH', `/links/${link.body.id}`, {
      user: owner,
      body: { disabled: false },
    });
    expect((await visit(slug)).status).toBe(302);

    expect((await call(harness, 'DELETE', `/links/${link.body.id}`, { user: owner })).status).toBe(
      204,
    );
    expect((await visit(slug)).status).toBe(404);
    // The slug stays taken after delete: a printed QR code must never start
    // sending its scans to somebody else's link.
    expect((await create({ url: 'https://example.com/x', slug }, stranger)).status).toBe(409);
  });

  it('an expiry two seconds out turns into 410 Gone when it passes, with no write in between', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const link = await create({ url: 'https://example.com/soon', expiresAt });
    expect(link.body.status).toBe('expiring');
    expect((await visit(link.body.slug)).status).toBe(302);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const r = await visit(link.body.slug);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain('Expired');
  });

  it('a click limit grants exactly that many visits, and the API reports limit_reached', async () => {
    const link = await create({ url: 'https://example.com/limited', maxClicks: 3 });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await visit(link.body.slug)).status);
    expect(statuses).toEqual([302, 302, 302, 410, 410]);
    const read = await call<Link>(harness, 'GET', `/links/${link.body.id}`, { user: owner });
    expect(read.body.status).toBe('limit_reached');
  });

  it('refuses a limit below the visits already granted, with the count in the answer', async () => {
    const link = await create({ url: 'https://example.com/busy' });
    for (let i = 0; i < 4; i += 1) await visit(link.body.slug);
    const reply = await call(harness, 'PATCH', `/links/${link.body.id}`, {
      user: owner,
      body: { maxClicks: 2 },
    });
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ code: 'UNPROCESSABLE', details: { redirects: 4 } });
  });

  it('HEAD checks a one-time link without spending it', async () => {
    const link = await create({ url: 'https://example.com/once', maxClicks: 1 });
    expect((await visit(link.body.slug, { method: 'HEAD' })).status).toBe(302);
    expect((await visit(link.body.slug, { method: 'HEAD' })).status).toBe(302);
    expect((await visit(link.body.slug)).status).toBe(302);
    expect((await visit(link.body.slug)).status).toBe(410);
  });
});

describe('QR codes', () => {
  it('encodes the short URL, not the destination, so editing the destination keeps printed codes valid', async () => {
    const link = await create({ url: 'https://example.com/printed' });
    const response = await fetch(`${harness.base}/links/${link.body.id}/qr?format=png&size=256`, {
      headers: { authorization: bearer(owner), 'x-forwarded-for': randomAddress() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(link.body.shortUrl);
  });

  it('serves SVG too', async () => {
    const link = await create({ url: 'https://example.com/svg' });
    const reply = await call(harness, 'GET', `/links/${link.body.id}/qr?format=svg`, {
      user: owner,
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('<svg');
  });
});

describe('the create budget (RATE_LIMIT_CREATE=30/min per user)', () => {
  it('refuses the 31st link in a minute, and still lets that user read their links', async () => {
    const spammer = await newAuthor(harness.db, 'links-spam');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        statuses.push((await create({ url: `https://example.com/${String(i)}` }, spammer)).status);
      }
      expect(statuses.filter((s) => s === 201)).toHaveLength(30);
      expect(statuses[30]).toBe(429);
      expect((await call(harness, 'GET', '/links', { user: spammer })).status).toBe(200);
    } finally {
      await harness.db.user.delete({ where: { id: spammer.id } });
    }
  });
});
