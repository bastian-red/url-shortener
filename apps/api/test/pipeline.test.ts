/**
 * The whole click path across three processes: a visit to the Go redirect
 * service, the stream, the Node worker, Postgres, the live feed back through
 * this API, and /status reporting all of it.
 *
 * scripts/integration.sh starts the redirect service (TRUST_PROXY_HOPS=1, so
 * this suite can play the proxy) and the worker (with MaxMind's test geo
 * database, where 81.2.69.160 is London, GB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CLICK_STREAM,
  liveClickSchema,
  statusSchema,
  type LiveClick,
  type Link,
  type SessionUser,
} from '@links/shared';

import {
  bearer,
  boot,
  call,
  eventually,
  newAuthor,
  randomAddress,
  visit,
  type Harness,
} from './support';

const LONDON = '81.2.69.160';

let harness: Harness;
let owner: SessionUser;

beforeAll(async () => {
  harness = await boot();
  owner = await newAuthor(harness.db, 'pipeline');
});

afterAll(async () => {
  await harness.db.user.delete({ where: { id: owner.id } });
  await harness.close();
});

/** Open the SSE feed and collect click events until `close()` is called. */
async function openLive(linkId: string): Promise<{ events: LiveClick[]; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${harness.base}/links/${linkId}/live`, {
    headers: { authorization: bearer(owner), 'x-forwarded-for': randomAddress() },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: LiveClick[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data !== undefined) events.push(liveClickSchema.parse(JSON.parse(data.slice(6))));
        }
      }
    } catch {
      // aborted
    }
  })();
  return { events, close: () => controller.abort() };
}

describe('one visit, end to end', () => {
  it('reaches the open live feed within 2 seconds, enriched, with no address in it (SPECS outcome 9)', async () => {
    const link = await call<Link>(harness, 'POST', '/links', {
      user: owner,
      body: { url: 'https://example.com/live' },
    });
    const live = await openLive(link.body.id);
    try {
      // Give the subscription a moment to register before the visit.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      expect(
        (await visit(link.body.slug, { address: LONDON, referer: 'https://www.t.co/abc' })).status,
      ).toBe(302);
      const event = await eventually(async () => live.events[0], 2000, 'the live click');
      const elapsed = Date.now() - started;
      expect(event).toMatchObject({
        linkId: link.body.id,
        country: 'GB',
        device: 'mobile',
        browser: 'Mobile Safari',
        os: 'iOS',
        referrer: 't.co',
        bot: false,
      });
      expect(JSON.stringify(event)).not.toContain(LONDON);
      console.log(`[pipeline] visit -> live event in ${String(elapsed)} ms`);
    } finally {
      live.close();
    }
  });

  it('stores the click with its country, and the raw IP is nowhere: not in Postgres, not left in the stream (SPECS outcome 7)', async () => {
    const link = await call<Link>(harness, 'POST', '/links', {
      user: owner,
      body: { url: 'https://example.com/private' },
    });
    const address = LONDON;
    await visit(link.body.slug, { address });
    const rows = await eventually(
      async () => {
        const found = await harness.db.$queryRaw<{ row: string }[]>`
        SELECT row_to_json(c)::text AS row FROM clicks c WHERE link_id = ${link.body.id}`;
        return found.length > 0 ? found : undefined;
      },
      5000,
      'the stored click',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toContain('"country":"GB"');
    expect(rows[0]!.row).not.toContain(address);

    // Every table that could hold it, searched as text.
    const anywhere = await harness.db.$queryRaw<{ hits: number }[]>`
      SELECT (
        (SELECT count(*) FROM clicks c WHERE row_to_json(c)::text LIKE ${'%' + address + '%'}) +
        (SELECT count(*) FROM link_hours h WHERE row_to_json(h)::text LIKE ${'%' + address + '%'}) +
        (SELECT count(*) FROM click_rollups r WHERE row_to_json(r)::text LIKE ${'%' + address + '%'}) +
        (SELECT count(*) FROM visitor_hours v WHERE row_to_json(v)::text LIKE ${'%' + address + '%'})
      )::int AS hits`;
    expect(anywhere[0]!.hits).toBe(0);

    // Processed entries are deleted from the stream, not just acknowledged.
    const entries = (await harness.redis.xrange(CLICK_STREAM, '-', '+')) as [string, string[]][];
    expect(entries.filter(([, fields]) => fields.includes(link.body.id))).toHaveLength(0);
  });

  it('counts every visit exactly once in the rollups, bots apart', async () => {
    const link = await call<Link>(harness, 'POST', '/links', {
      user: owner,
      body: { url: 'https://example.com/count' },
    });
    for (let i = 0; i < 20; i += 1) await visit(link.body.slug);
    for (let i = 0; i < 3; i += 1)
      await visit(link.body.slug, {
        userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      });
    // Wait for BOTH counts: the worker may commit the humans and the bots in
    // different batches, and asserting the bots the moment the humans landed
    // raced on CI.
    const hours = await eventually(
      async () => {
        const sum = await harness.db.linkHour.aggregate({
          where: { linkId: link.body.id },
          _sum: { clicks: true, bots: true },
        });
        return sum._sum.clicks === 20 && sum._sum.bots === 3 ? sum._sum : undefined;
      },
      5000,
      '20 human and 3 bot clicks',
    );
    expect(hours).toEqual({ clicks: 20, bots: 3 });
    const read = await call<Link>(harness, 'GET', `/links/${link.body.id}`, { user: owner });
    expect(read.body.clicks).toBe(20);
  });
});

describe('/status', () => {
  it('reports all three services healthy and the pipeline numbers, without a token', async () => {
    const reply = await call(harness, 'GET', '/status', { user: null });
    expect(reply.status).toBe(200);
    const status = statusSchema.parse(reply.body);
    expect(status.services.map((s) => `${s.service}:${s.status}`)).toEqual([
      'api:ok',
      'redirect:ok',
      'click-worker:ok',
    ]);
    expect(status.pipeline).not.toBeNull();
    expect(status.pipeline!.processed).toBeGreaterThan(0);
  });
});
