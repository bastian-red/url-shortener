/**
 * The seeded hero link's report: ~30,000 clicks over 30 days, and the brush.
 */
import { expect, heroId, signIn, test } from '../fixtures';

const kpi = (text: string) => Number(text.replace(/,/gu, ''));

test('the 30-day report shows real breakdowns, and a brushed window re-scopes them', async ({
  page,
}) => {
  await signIn(page);
  const id = await heroId(page);
  await page.goto(`/links/${id}?range=30d`);
  await expect(page.locator('.report[data-ready]')).toBeVisible();

  const whole = kpi(await page.getByTestId('kpi-clicks').innerText());
  expect(whole).toBeGreaterThan(25_000);
  await expect(page.locator('[data-dimension="country"]')).toContainText('United States');
  await expect(page.locator('[data-dimension="referrer"]')).toContainText('t.co');

  // Drag across the middle third of the timeline.
  const plot = page.locator('.timeline svg g[role="slider"] rect');
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const scope = page.locator('.scope');
  await expect(scope).toBeVisible();
  await expect(scope).not.toContainText('…');
  const scoped = kpi(await page.getByTestId('kpi-clicks').innerText());
  expect(scoped).toBeGreaterThan(0);
  expect(scoped).toBeLessThan(whole);

  await page.getByRole('button', { name: 'Show the whole range' }).click();
  await expect(scope).toBeHidden();
  expect(kpi(await page.getByTestId('kpi-clicks').innerText())).toBe(whole);
});

test('the brush works from the keyboard', async ({ page }) => {
  await signIn(page);
  const id = await heroId(page);
  await page.goto(`/links/${id}?range=7d`);
  await expect(page.locator('.report[data-ready]')).toBeVisible();
  const whole = kpi(await page.getByTestId('kpi-clicks').innerText());

  const slider = page.getByRole('slider', { name: 'Select a time window' });
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.locator('.scope')).toBeVisible();
  await expect(page.locator('.scope')).not.toContainText('…');
  expect(kpi(await page.getByTestId('kpi-clicks').innerText())).toBeLessThan(whole);

  await slider.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scope')).toBeHidden();
});

test('every chart has its numbers as a table', async ({ page }) => {
  await signIn(page);
  const id = await heroId(page);
  await page.goto(`/links/${id}?range=24h`);
  await page.getByText('Show the numbers as a table').click();
  await expect(page.locator('.timeline details table tbody tr')).toHaveCount(24);
  await page.getByText('Show the week as a table').click();
  await expect(page.locator('details.data-table').last().locator('tbody tr')).toHaveCount(7);
});
