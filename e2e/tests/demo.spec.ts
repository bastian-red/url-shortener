/**
 * The README's demo, captured as frames by `scripts/demo-gif.sh` (DEMO=1 only;
 * playwright.config.ts ignores this file otherwise).
 *
 * The story in six frames: a link shortened from the command bar, the hero
 * link's month, a brushed window re-scoping everything below it, clicks from
 * four countries landing on the tape, the status page, and the redirect
 * service's own "turned off" page. One viewport each, so the GIF does not jump.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, heroId, HERO_SLUG, SHORT_BASE_URL, shorten, signIn, test } from '../fixtures';

const SHOTS = join(__dirname, '..', 'demo-shots');

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });

async function frame(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Addresses with known answers in MaxMind's test database. */
const VISITORS = [
  {
    ip: '81.2.69.160',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ref: 'https://t.co/x',
  },
  {
    ip: '216.160.83.56',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ref: 'https://news.ycombinator.com/',
  },
  {
    ip: '89.160.20.112',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    ref: 'https://www.linkedin.com/feed/',
  },
  {
    ip: '175.16.199.1',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    ref: '',
  },
];

test('demo', async ({ page, request }) => {
  await signIn(page);
  await shorten(
    page,
    'https://example.com/docs/a-very-long-path/that-nobody-wants-to-type?utm_source=newsletter',
  );
  await frame(page, '01-shortened');

  const id = await heroId(page);
  await page.goto(`/links/${id}?range=30d`);
  await expect(page.locator('.report[data-ready]')).toBeVisible();
  await frame(page, '02-report');

  const plot = page.locator('.timeline svg g[role="slider"] rect');
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.66, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.scope')).not.toContainText('…');
  await page.mouse.move(0, 0);
  await page.mouse.wheel(0, 360);
  await frame(page, '03-brushed');

  await page.mouse.wheel(0, -2000);
  await expect(page.getByTestId('tape-state')).toHaveText(/Live/u);
  for (const v of VISITORS) {
    await request.get(`${SHORT_BASE_URL}/${HERO_SLUG}`, {
      maxRedirects: 0,
      headers: {
        'x-forwarded-for': v.ip,
        'user-agent': v.ua,
        ...(v.ref === '' ? {} : { referer: v.ref }),
      },
    });
    await page.waitForTimeout(250);
  }
  await expect(page.getByTestId('tape').locator('.tape-item')).toHaveCount(VISITORS.length);
  await frame(page, '04-live');

  await page.goto('/status');
  await expect(page.getByTestId('overall')).toBeVisible();
  await frame(page, '05-status');

  await page.goto(`${SHORT_BASE_URL}/old-promo`);
  await frame(page, '06-redirect-410');
});
