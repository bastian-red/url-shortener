/**
 * axe over every route, in both colour schemes, zero violations. Includes the
 * Go redirect service's own error pages, which share the palette.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { expect, heroId, SHORT_BASE_URL, signIn, test } from '../fixtures';

const SCHEMES = ['light', 'dark'] as const;
const RECORDING = process.env.BASELINE === '1';

async function scan(page: Page, testInfo: TestInfo, route: string, scheme: string) {
  // Measure the resting state, not an entry animation at partial opacity.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  if (RECORDING) {
    await testInfo.attach('a11y', {
      contentType: 'application/json',
      body: JSON.stringify({ route, scheme, violations: results.violations }),
    });
    return;
  }
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('sign in', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await scan(page, testInfo, '/sign-in', scheme);
    });

    test('sign up', async ({ page }, testInfo) => {
      await page.goto('/sign-up');
      await scan(page, testInfo, '/sign-up', scheme);
    });

    test('status', async ({ page }, testInfo) => {
      await page.goto('/status');
      await scan(page, testInfo, '/status', scheme);
    });

    test('ledger, with the options open and an error showing', async ({ page }, testInfo) => {
      await signIn(page);
      await page.getByText('Custom slug, title, expiry and click limit').click();
      await page.getByRole('button', { name: 'Shorten', exact: true }).click();
      await expect(page.locator('.form-error')).toBeVisible();
      await scan(page, testInfo, '/', scheme);
    });

    test('link page, with a brushed window, both tables and the edit panel open', async ({
      page,
    }, testInfo) => {
      await signIn(page);
      const id = await heroId(page);
      await page.goto(`/links/${id}?range=30d`);
      await expect(page.locator('.report[data-ready]')).toBeVisible();
      const slider = page.getByRole('slider', { name: 'Select a time window' });
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Enter');
      await expect(page.locator('.scope')).not.toContainText('…');
      await page.getByText('Show the numbers as a table').click();
      await page.getByText('Show the week as a table').click();
      await page.getByText('Edit link').click();
      await scan(page, testInfo, '/links/:id', scheme);
    });

    test('redirect service: 404 page', async ({ page }, testInfo) => {
      const response = await page.goto(`${SHORT_BASE_URL}/no-such-slug-here`);
      expect(response?.status()).toBe(404);
      await scan(page, testInfo, 'redirect 404', scheme);
    });

    test('redirect service: 410 page (a disabled seeded link)', async ({ page }, testInfo) => {
      const response = await page.goto(`${SHORT_BASE_URL}/old-promo`);
      expect(response?.status()).toBe(410);
      await expect(
        page.getByRole('heading', { name: 'This link has been turned off' }),
      ).toBeVisible();
      await scan(page, testInfo, 'redirect 410', scheme);
    });
  });
}
