/**
 * SPECS outcome 3: every click is counted exactly once, including when the
 * worker dies mid-batch.
 *
 * Two ways to die, both covered:
 *
 * 1. **After the commit, before XACK.** Deterministic: a worker whose
 *    acknowledgement pipeline fails once. Its entries stay pending, a second
 *    consumer reclaims them with XAUTOCLAIM and re-runs the batch, and the
 *    idempotent insert adds nothing.
 * 2. **SIGKILL at an arbitrary point.** The real process, killed while about
 *    half of 2,000 events are stored, then a fresh process started. Whatever
 *    state the kill left (an open transaction rolled back, a committed batch
 *    unacknowledged, or neither) the final count must be exactly 2,000 and the
 *    rollups must equal a recount.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLLUP_DRIFT_SQL } from '../src/recount';
import { CLICK_STREAM } from '@links/shared';

import { ClickWorker } from '../src/worker';
import { GROUP } from '../src/stream';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const SECRET = 'integration-visitor-secret';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

let pool: pg.Pool;
let redis: Redis;
const userId = `ccrashuser${String(Date.now())}`.padEnd(25, '0').slice(0, 25);

async function makeLink(label: string): Promise<string> {
  const id = `ccrash${label}${String(Date.now())}`.padEnd(25, '0').slice(0, 25);
  await pool.query(
    `INSERT INTO links (id, user_id, slug, url) VALUES ($1, $2, $3, 'https://example.com/crash')`,
    [id, userId, `crash-${label}-${String(Date.now())}`],
  );
  return id;
}

async function enqueue(linkId: string, count: number): Promise<void> {
  const pipeline = redis.pipeline();
  const base = Date.now();
  for (let i = 0; i < count; i += 1) {
    pipeline.xadd(
      CLICK_STREAM,
      '*',
      'v',
      '1',
      'link',
      linkId,
      'slug',
      'crash',
      'ts',
      String(base + i),
      'ip',
      `198.51.100.${String(i % 250)}`,
      'ua',
      UA,
      'ref',
      '',
      'lang',
      'en',
    );
  }
  await pipeline.exec();
}

async function stored(linkId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM clicks WHERE link_id = $1',
    [linkId],
  );
  return Number(rows[0]!.n);
}

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const noop = () => undefined;

/**
 * Every worker this file spawns, so afterAll can kill any that a failing
 * assertion left running. Without it, a red run orphans a worker that keeps
 * consuming the stream with whatever code it was started with, and the NEXT
 * run fails for a reason that has nothing to do with the code under test.
 */
const children = new Set<ChildProcess>();

beforeAll(async () => {
  if (DATABASE_URL === '' || REDIS_URL === '')
    throw new Error('Run through ./scripts/integration.sh');
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  redis = new Redis(REDIS_URL);
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Crash', 'x')`,
    [userId, `${userId}@links.test`],
  );
  // Start from a stream nobody else is consuming in this lane.
  await redis.del(CLICK_STREAM);
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await redis.del(CLICK_STREAM);
  await pool.end();
  redis.disconnect();
});

describe('committed but not acknowledged', () => {
  it('is reclaimed by another consumer and adds nothing the second time', async () => {
    const linkId = await makeLink('ack');
    await enqueue(linkId, 100);

    // Worker A: commits, then its XACK pipeline fails (as if it died there).
    const flaky = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === 'pipeline') {
          return () => {
            const p = target.pipeline();
            p.exec = () => Promise.reject(new Error('simulated crash before XACK'));
            return p;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const a = new ClickWorker({
      redis: flaky,
      pool,
      geo: () => null,
      secret: SECRET,
      consumer: 'crash-a',
      batchSize: 100,
      blockMs: 50,
      claimIdleMs: 200,
      log: noop,
    });
    await a.ensureGroup();
    const reply = await redis.xreadgroup(
      'GROUP',
      GROUP,
      'crash-a',
      'COUNT',
      100,
      'STREAMS',
      CLICK_STREAM,
      '>',
    );
    const entries = (reply as [string, [string, string[]][]][])[0]![1];
    await expect(a.process(entries)).rejects.toThrow('simulated crash');
    expect(await stored(linkId)).toBe(100);
    const pending = (await redis.xpending(CLICK_STREAM, GROUP)) as [number];
    expect(pending[0]).toBe(100);

    // Worker B reclaims the orphaned entries once they are idle.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const b = new ClickWorker({
      redis,
      pool,
      geo: () => null,
      secret: SECRET,
      consumer: 'crash-b',
      batchSize: 100,
      blockMs: 50,
      claimIdleMs: 200,
      log: noop,
    });
    await b.reclaim();
    expect(b.stats).toMatchObject({ processed: 100, inserted: 0, duplicates: 100 });
    expect(await stored(linkId)).toBe(100);
    expect(((await redis.xpending(CLICK_STREAM, GROUP)) as [number])[0]).toBe(0);

    const { rows } = await pool.query(ROLLUP_DRIFT_SQL, [linkId]);
    expect(rows).toEqual([]);
    const hours = await pool.query<{ clicks: string }>(
      'SELECT sum(clicks) AS clicks FROM link_hours WHERE link_id = $1',
      [linkId],
    );
    expect(Number(hours.rows[0]!.clicks)).toBe(100);
  });
});

describe('SIGKILL mid-stream', () => {
  function startWorker(port: number): ChildProcess {
    const child = spawn(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL,
        REDIS_URL,
        VISITOR_HASH_SECRET: SECRET,
        GEOIP_DB_PATH: '/nonexistent',
        WORKER_HEALTH_PORT: String(port),
        // Small batches, so 2,000 events take many transactions and a kill
        // lands between, inside and after them.
        WORKER_BATCH_SIZE: '10',
        WORKER_BLOCK_MS: '50',
        WORKER_CLAIM_IDLE_MS: '500',
      },
      stdio: 'ignore',
    });
    children.add(child);
    return child;
  }

  it('loses nothing and counts nothing twice: exactly 2,000 rows, rollups equal a recount', async () => {
    const linkId = await makeLink('kill');
    const TOTAL = 2000;
    await enqueue(linkId, TOTAL);

    const first = startWorker(14_201);
    await until(async () => (await stored(linkId)) >= TOTAL * 0.4, 30_000, '40% stored');
    first.kill('SIGKILL');
    await new Promise((resolve) => first.once('exit', resolve));
    const atKill = await stored(linkId);
    // Not vacuous: the kill landed while work remained.
    expect(atKill).toBeGreaterThan(0);
    expect(atKill).toBeLessThan(TOTAL);

    const second = startWorker(14_202);
    try {
      await until(
        async () =>
          (await stored(linkId)) === TOTAL &&
          ((await redis.xpending(CLICK_STREAM, GROUP)) as [number])[0] === 0,
        60_000,
        'all 2,000 stored and nothing pending',
      );
    } finally {
      second.kill('SIGTERM');
      await new Promise((resolve) => second.once('exit', resolve));
    }
    console.log(
      `[crash] killed at ${String(atKill)} of ${String(TOTAL)}; restarted worker finished the rest`,
    );

    expect(await stored(linkId)).toBe(TOTAL);
    const hours = await pool.query<{ clicks: string }>(
      'SELECT sum(clicks) AS clicks FROM link_hours WHERE link_id = $1',
      [linkId],
    );
    expect(Number(hours.rows[0]!.clicks)).toBe(TOTAL);
    const { rows } = await pool.query(ROLLUP_DRIFT_SQL, [linkId]);
    expect(rows).toEqual([]);
  }, 120_000);
});
