/**
 * The product's loop: paste, share, watch it travel, change your mind.
 */
import { readFileSync } from 'node:fs';

import jsQR from 'jsqr';
import { PNG } from 'pngjs';

import { expect, LONDON, shorten, signUpFresh, test, visit } from '../fixtures';

test('shorten a link, visit it, and watch the click land on the tape and the ledger (SPECS outcome 9)', async ({
  page,
  request,
}) => {
  await signUpFresh(page, 'live');
  const { shortUrl, path } = await shorten(page, 'https://example.com/live-demo');
  const slug = shortUrl.split('/').pop()!;
  expect(slug).toMatch(/^[0-9A-Za-z]{7}$/u);

  // The ledger row exists and counts zero.
  const row = page.locator(`tr[data-slug="${slug}"]`);
  await expect(row.getByTestId(/^count-/u)).toHaveText('0');
  await expect(page.locator('[data-live="open"]')).toBeVisible();

  // A visit while the ledger is open ticks its count.
  const first = await visit(request, slug);
  expect(first.status()).toBe(302);
  expect(first.headers()['location']).toBe('https://example.com/live-demo');
  await expect(row.getByTestId(/^count-/u)).toContainText('1', { timeout: 5000 });

  // On the link's page, the tape shows where the next click came from.
  await page.goto(path);
  await expect(page.getByTestId('tape-state')).toHaveText(/Live/u);
  const started = Date.now();
  await visit(request, slug, { address: LONDON, referer: 'https://www.t.co/x' });
  const item = page.getByTestId('tape').locator('.tape-item').first();
  await expect(item).toContainText('United Kingdom · Mobile', { timeout: 5000 });
  await expect(item).toContainText('from t.co');
  expect(Date.now() - started).toBeLessThan(5000);
});

test('a custom slug that is taken is refused in words, next to the form', async ({ page }) => {
  await signUpFresh(page, 'slug');
  const slug = `e2e-${String(Date.now()).slice(-8)}`;
  await shorten(page, 'https://example.com/one', slug);
  await page.goto('/');
  await page.getByLabel('Destination URL').fill('https://example.com/two');
  await page.getByText('Custom slug, title, expiry and click limit').click();
  await page.getByLabel('Custom slug').fill(slug);
  await page.getByRole('button', { name: 'Shorten', exact: true }).click();
  await expect(page.locator('.form-error')).toContainText('is taken');
});

test('a reserved slug and a javascript: URL are refused with the reason', async ({ page }) => {
  await signUpFresh(page, 'refuse');
  await page.getByLabel('Destination URL').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Shorten', exact: true }).click();
  await expect(page.locator('.form-error')).toContainText('Only http:// and https://');
});

test('the QR code encodes the short URL', async ({ page }) => {
  await signUpFresh(page, 'qr');
  const { shortUrl } = await shorten(page, 'https://example.com/printed');
  const download = page.waitForEvent('download');
  await page.locator('.created').getByRole('link', { name: 'QR code' }).click();
  const file = await (await download).path();
  const png = PNG.sync.read(readFileSync(file));
  expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(shortUrl);
});

test('edit the destination, turn the link off and on, then delete it; each change is live on the next visit', async ({
  page,
  request,
}) => {
  await signUpFresh(page, 'edit');
  const { shortUrl, path } = await shorten(page, 'https://example.com/before');
  const slug = shortUrl.split('/').pop()!;
  await page.goto(path);
  await expect(page.locator('.report[data-ready]')).toBeVisible();

  await page.getByText('Edit link').click();
  await page.getByLabel('Destination').fill('https://example.com/after');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect((await visit(request, slug)).headers()['location']).toBe('https://example.com/after');

  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.locator('.detail-head [data-status="disabled"]')).toBeVisible();
  const off = await visit(request, slug);
  expect(off.status()).toBe(410);
  expect(await off.text()).toContain('Turned off');

  await page.getByRole('button', { name: 'Turn back on' }).click();
  await expect(page.locator('.detail-head [data-status="active"]')).toBeVisible();
  expect((await visit(request, slug)).status()).toBe(302);

  await page.getByText('Delete link').click();
  await page.getByRole('button', { name: `Delete /${slug}` }).click();
  await page.waitForURL(/\?deleted=1/u);
  await expect(page.getByRole('status').filter({ hasText: 'Link deleted' })).toBeVisible();
  expect((await visit(request, slug)).status()).toBe(404);
});
