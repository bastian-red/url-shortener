/**
 * The demo workspace: one account, six links in every state a link can be in,
 * and about 50,000 clicks over the last 30 days.
 *
 * Five properties, each with the mechanism that holds it:
 *
 * 1. **The clicks go through production code.** Every synthetic click is
 *    classified by the worker's own `classify` (from a real user-agent string),
 *    hashed by its `visitorHash`, and written by its `writeBatch`, the same
 *    transaction the stream consumer runs. The rollups the dashboard reads are
 *    therefore real rollups, and `pnpm db:recount` proves it.
 * 2. **It is deterministic relative to its anchor.** A seeded PRNG and a fixed
 *    anchor (the current UTC hour) make every run within the same hour produce
 *    the same rows; across hours, the same rows shifted in time.
 *    `scripts/seed-check.sh` digests them relative to the anchor. Anchoring to
 *    "now" rather than to a fixed date is deliberate: a dashboard seeded with
 *    September's clicks shows an empty "last 7 days" to anyone who clones the
 *    repo in November.
 * 3. **It is idempotent and touches only its own rows.** It deletes the demo
 *    user by id (cascading to links, clicks and rollups) and clears those
 *    links' Redis keys, then recreates everything.
 * 4. **No IP address is generated, let alone stored.** Visitors are synthetic
 *    identities hashed like real ones.
 * 5. **The constants are readable from outside.** `scripts/seed-check.sh`,
 *    `scripts/dev-smoke.sh` and the E2E suite `sed` the `const NAME = '...'`
 *    lines below. One line each, single quotes, no template literals.
 */
import pg from 'pg';
import { Redis } from 'ioredis';

import { CLICK_COUNT_PREFIX, idSchema, LINK_CACHE_PREFIX, slugSchema } from '@links/shared';
import { hashPassword } from '@links/shared/server';
import { classify, hourOf, visitorHash, writeBatch, type EnrichedClick } from '@links/click-worker';

import pkg from '../generated/client/index.js';

const { PrismaClient } = pkg;

const DEMO_EMAIL = 'demo@links.test';
const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_NAME = 'Morgan Reyes';
const HERO_SLUG = 'launch';
const HERO_URL = 'https://example.com/blog/spring-launch?utm_source=short';
const HERO_TITLE = 'Spring launch post';

/** Window of synthetic traffic, ending at the anchor. */
const DAYS = 30;

const ANCHOR = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Same shape as cuid(): 25 lowercase alphanumerics, so every contract accepts it. */
function seedId(kind: string, name: string): string {
  return `c${kind}${name}${'0'.repeat(40)}`.slice(0, 25);
}

const USER_ID = seedId('user', 'morgan');

interface SeedLink {
  id: string;
  slug: string;
  url: string;
  title: string;
  clicks: number;
  /** Relative to ANCHOR, in ms. */
  createdOffset: number;
  expiresOffset: number | null;
  maxClicks: number | null;
  disabled: boolean;
  /** Traffic shape over the window: per-day weight as a function of days since creation. */
  shape: (dayIndex: number) => number;
  referrers: [string, number][];
}

const LINKS: SeedLink[] = [
  {
    id: seedId('link', 'launch'),
    slug: HERO_SLUG,
    url: HERO_URL,
    title: HERO_TITLE,
    clicks: 30_000,
    createdOffset: -DAYS * DAY,
    expiresOffset: null,
    maxClicks: null,
    disabled: false,
    // Launch day five days in, a long tail, and a second bump when it hit HN.
    shape: (d) => (d < 5 ? 0.3 : 6 * Math.exp(-(d - 5) / 4) + 0.6 + (d === 17 ? 4 : d === 18 ? 1.5 : 0)),
    referrers: [['t.co', 30], ['', 22], ['linkedin.com', 14], ['news.ycombinator.com', 12], ['google.com', 8], ['slack.com', 6], ['reddit.com', 5], ['bsky.app', 3]],
  },
  {
    id: seedId('link', 'docs'),
    slug: 'docs',
    url: 'https://example.com/docs/getting-started',
    title: 'Getting started guide',
    clicks: 10_000,
    createdOffset: -DAYS * DAY,
    expiresOffset: null,
    maxClicks: null,
    disabled: false,
    shape: () => 1,
    referrers: [['', 40], ['google.com', 25], ['github.com', 20], ['stackoverflow.com', 10], ['slack.com', 5]],
  },
  {
    id: seedId('link', 'careers'),
    slug: 'k7Qm2Xa',
    url: 'https://example.com/careers/senior-platform-engineer',
    title: 'Careers: senior platform engineer',
    clicks: 4_000,
    createdOffset: -12 * DAY,
    expiresOffset: 18 * HOUR,
    maxClicks: null,
    disabled: false,
    shape: (d) => (d >= DAYS - 12 ? 1 : 0),
    referrers: [['linkedin.com', 55], ['', 20], ['t.co', 15], ['google.com', 10]],
  },
  {
    id: seedId('link', 'webinar'),
    slug: 'webinar-oct',
    url: 'https://example.com/events/october-webinar',
    title: 'October webinar registration',
    clicks: 3_000,
    createdOffset: -20 * DAY,
    expiresOffset: -3 * DAY,
    maxClicks: null,
    disabled: false,
    // Traffic stops at expiry: a redirect after it would have answered 410.
    shape: (d) => (d >= DAYS - 20 && d < DAYS - 3 ? 1 + (d >= DAYS - 6 ? 2 : 0) : 0),
    referrers: [['', 35], ['linkedin.com', 30], ['t.co', 20], ['mail.google.com', 15]],
  },
  {
    id: seedId('link', 'beta'),
    slug: 'beta-invite',
    url: 'https://example.com/beta/join?code=SPRING',
    title: 'Private beta invite',
    clicks: 500,
    createdOffset: -9 * DAY,
    expiresOffset: null,
    maxClicks: 500,
    disabled: false,
    shape: (d) => (d >= DAYS - 9 && d < DAYS - 2 ? 1 : 0),
    referrers: [['', 70], ['slack.com', 20], ['discord.com', 10]],
  },
  {
    id: seedId('link', 'promo'),
    slug: 'old-promo',
    url: 'https://example.com/promo/summer',
    title: 'Summer promo (paused)',
    clicks: 1_500,
    createdOffset: -DAYS * DAY,
    expiresOffset: null,
    maxClicks: null,
    disabled: true,
    shape: (d) => (d < 15 ? 1 : 0),
    referrers: [['', 30], ['instagram.com', 40], ['facebook.com', 30]],
  },
];

// --- deterministic randomness ----------------------------------------------------

/** mulberry32: small, fast, and good enough for synthetic traffic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rand: () => number, weighted: readonly [T, number][]): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weighted[weighted.length - 1]![0];
}

const COUNTRIES: [string, number][] = [
  ['US', 28], ['GB', 10], ['DE', 8], ['CL', 7], ['IN', 7], ['BR', 6], ['FR', 5], ['CA', 5], ['ES', 4],
  ['MX', 4], ['JP', 3], ['AU', 3], ['NL', 3], ['SE', 2], ['AR', 2], ['', 3],
];

const USER_AGENTS: [string, number][] = [
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 26],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 20],
  ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 7],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1', 5],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 14],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 8],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 6],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 4],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 2],
  ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 4],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 1.5],
  ['Twitterbot/1.0', 1],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 0.8],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 0.4],
  ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 0.3],
];

/** UTC hour-of-day weights: the audience is spread from the Americas to India. */
const DIURNAL = [3, 2, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 14, 13, 12, 10, 8, 6, 4];

function generate(link: SeedLink, seed: number, secret: string): EnrichedClick[] {
  const rand = prng(seed);
  const start = ANCHOR.getTime() - DAYS * DAY;
  // Per-hour weights over the window, never after the link's expiry.
  const weights: number[] = [];
  for (let h = 0; h < DAYS * 24; h += 1) {
    const at = start + h * HOUR;
    const day = Math.floor(h / 24);
    const weekday = new Date(at).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.65 : 1;
    const ended = link.expiresOffset !== null && at >= ANCHOR.getTime() + link.expiresOffset;
    const born = at >= ANCHOR.getTime() + link.createdOffset;
    weights.push(ended || !born ? 0 : link.shape(day) * DIURNAL[h % 24]! * weekend);
  }
  const cumulative: number[] = [];
  weights.reduce((sum, w, i) => (cumulative[i] = sum + w), 0);
  const total = cumulative[cumulative.length - 1]!;

  const visitors = Math.max(20, Math.floor(link.clicks / 2.6));
  const clicks: EnrichedClick[] = [];
  for (let i = 0; i < link.clicks; i += 1) {
    const roll = rand() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < roll) lo = mid + 1;
      else hi = mid;
    }
    const at = new Date(start + lo * HOUR + Math.floor(rand() * HOUR));
    const ua = pick(rand, USER_AGENTS);
    const kind = classify(ua);
    const visitor = Math.floor(rand() ** 1.6 * visitors);
    clicks.push({
      // Shaped like a stream entry id ("<ms>-<seq>"); `i` keeps it unique.
      id: `${String(at.getTime())}-${String(seed)}${String(i)}`,
      at,
      hour: hourOf(at),
      linkId: link.id,
      country: kind.isBot ? 'US' : pick(rand, COUNTRIES),
      region: '',
      city: '',
      ...kind,
      referrer: kind.isBot ? '' : pick(rand, link.referrers),
      visitor: visitorHash(secret, at, `seed-visitor-${link.slug}-${String(visitor)}`, ua),
    });
  }
  return clicks;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set');
  for (const link of LINKS) {
    idSchema.parse(link.id);
    slugSchema.parse(link.slug);
  }
  idSchema.parse(USER_ID);
  // The seed's visitors are synthetic, so the secret only has to be stable.
  const secret = process.env.VISITOR_HASH_SECRET?.trim() || 'seed-visitor-secret-not-a-real-one';

  const prisma = new PrismaClient();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await prisma.user.deleteMany({ where: { OR: [{ id: USER_ID }, { email: DEMO_EMAIL }] } });
    await prisma.user.create({
      data: { id: USER_ID, email: DEMO_EMAIL, name: DEMO_NAME, passwordHash: hashPassword(DEMO_PASSWORD), createdAt: new Date(ANCHOR.getTime() - DAYS * DAY) },
    });
    for (const link of LINKS) {
      await prisma.link.create({
        data: {
          id: link.id,
          userId: USER_ID,
          slug: link.slug,
          url: link.url,
          title: link.title,
          createdAt: new Date(ANCHOR.getTime() + link.createdOffset),
          expiresAt: link.expiresOffset === null ? null : new Date(ANCHOR.getTime() + link.expiresOffset),
          maxClicks: link.maxClicks,
          disabled: link.disabled,
        },
      });
    }

    const client = await pool.connect();
    try {
      await client.query(`SELECT ensure_click_partitions($1::timestamptz - INTERVAL '${String(DAYS + 1)} days', $1::timestamptz + INTERVAL '2 months')`, [ANCHOR]);
      let written = 0;
      for (const [index, link] of LINKS.entries()) {
        const clicks = generate(link, 1000 + index, secret).sort((a, b) => a.at.getTime() - b.at.getTime());
        for (let i = 0; i < clicks.length; i += 2000) {
          const result = await writeBatch(client, clicks.slice(i, i + 2000));
          written += result.inserted.length;
        }
      }
      console.log(`seed: ${String(LINKS.length)} links, ${String(written)} clicks for ${DEMO_EMAIL} (anchor ${ANCHOR.toISOString()})`);
    } finally {
      client.release();
    }

    // Drop the redirect cache for the seeded slugs. The click-limit counters go
    // too: the redirect service re-seeds them from link_hours on the next miss,
    // which is exactly the path a cold Redis takes in production.
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl !== undefined && redisUrl !== '') {
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      try {
        await redis.connect();
        await redis.del(...LINKS.flatMap((l) => [`${LINK_CACHE_PREFIX}${l.slug}`, `${CLICK_COUNT_PREFIX}${l.slug}`]));
      } catch (error) {
        console.warn(`seed: could not clear the redirect cache (${(error as Error).message}); it expires on its own`);
      } finally {
        redis.disconnect();
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
