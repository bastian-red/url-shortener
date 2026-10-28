/**
 * The redesign's promises that only a browser can check (docs/DESIGN.md).
 */
import { expect, HERO_SLUG, SHORT_BASE_URL, signIn, test } from '../fixtures';

const PHONE = { width: 390, height: 844 };

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  for (const [name, path] of [
    ['sign-in', '/sign-in'],
    ['sign-up', '/sign-up'],
    ['status', '/status'],
    ['redirect 404', `${SHORT_BASE_URL}/no-such-slug-here`],
  ] as const) {
    test(`${name} never scrolls sideways`, async ({ page }) => {
      await page.goto(path);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll, `${name} is ${String(scroll - client)}px wider than the screen`).toBeLessThanOrEqual(client);
    });
  }

  test('the ledger and a link report never scroll sideways', async ({ page }) => {
    await signIn(page);
    for (const path of ['/', null]) {
      if (path === null) {
        await page.locator(`tr[data-slug="${HERO_SLUG}"] a.slug-pill`).click();
        await expect(page.locator('.report[data-ready]')).toBeVisible();
      } else {
        await page.goto(path);
      }
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll, `${page.url()} is ${String(scroll - client)}px wider than the screen`).toBeLessThanOrEqual(client);
    }
  });

  test('the timeline axis stays readable: labels are drawn at 11px, not scaled down', async ({ page }) => {
    await signIn(page);
    await page.locator(`tr[data-slug="${HERO_SLUG}"] a.slug-pill`).click();
    const label = page.locator('.timeline .axis-label').first();
    await expect(label).toBeVisible();
    const height = await label.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(9);
  });
});

test('an idle link says so in words instead of drawing a flat line; a moving one draws its day', async ({
  page,
}) => {
  await signIn(page);
  const idle = page.locator('tr[data-slug]').filter({ has: page.locator('[data-idle="true"]') });
  await expect(idle.first()).toBeVisible();
  for (const row of await idle.all()) {
    await expect(row.locator('.spark-cell')).toHaveText('No clicks in 24 h');
    await expect(row.locator('.sparkline')).toHaveCount(0);
  }
  const moving = page.locator(`tr[data-slug="${HERO_SLUG}"] .spark-cell`);
  await expect(moving.locator('.sparkline')).toHaveCount(1);
  await expect(moving).toContainText(/in 24 h/u);
});

test('the route board joins each referrer and each country to the hub, never to each other', async ({
  page,
}) => {
  await signIn(page);
  await page.locator(`tr[data-slug="${HERO_SLUG}"] a.slug-pill`).click();
  const board = page.locator('.route-board');
  await expect(board.locator('.route-hub')).toHaveText(`/${HERO_SLUG}`);
  const inRows = await board.locator('[data-side="in"] .breakdown-row').count();
  const outRows = await board.locator('[data-side="out"] .breakdown-row').count();
  expect(inRows).toBeGreaterThan(0);
  expect(outRows).toBeGreaterThan(0);
  await expect(board.locator('.route-leg[data-side="in"]')).toHaveCount(inRows);
  await expect(board.locator('.route-leg[data-side="out"]')).toHaveCount(outRows);
  // The drawing is decoration over real lists: hidden from assistive technology.
  await expect(board.locator('.route-map')).toHaveAttribute('aria-hidden', 'true');

  // Each leg ends on its own row: the leg's last y and the row's centre agree within 2px.
  const offsets = await board.evaluate((root) => {
    const svg = root.querySelector('.route-map svg')!.getBoundingClientRect();
    const rows = [...root.querySelectorAll('[data-side="out"] .breakdown-row')].map((r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2 - svg.top;
    });
    const legs = [...root.querySelectorAll('.route-leg[data-side="out"]')].map((p) =>
      Number((p.getAttribute('d') ?? '').trim().split(' ').pop()),
    );
    return rows.map((y, i) => Math.abs(y - (legs[i] ?? Number.NaN)));
  });
  for (const offset of offsets) expect(offset).toBeLessThan(2);
});
