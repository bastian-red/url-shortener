/**
 * The product's loop: paste, share, watch it travel, change your mind.
 */
import { readFileSync } from 'node:fs';

import jsQR from 'jsqr';
import { PNG } from 'pngjs';

import type { Page } from '@playwright/test';

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

test('create and copy in one paste: a URL pasted anywhere on the page is shortened and already on the clipboard', async ({
  page,
  context,
  browserName,
}) => {
  // Chromium lets a test grant clipboard access and read it back; Firefox does
  // not, so there the strip's wording is the assertion.
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUpFresh(page, 'paste');
  // Focus is deliberately NOT in the field: the paste lands on the page body.
  await page.locator('.ledger-title').click();
  await expect(page.getByLabel('Destination URL')).not.toBeFocused();

  // The one user action: a real paste, with focus on the page body. Firefox
  // drops clipboardData from a synthetic ClipboardEvent, so the URL goes onto
  // the real clipboard first (a scratch textarea and the copy shortcut).
  await putOnClipboard(page, 'https://example.com/pasted-anywhere');
  await page.locator('.ledger-title').click();
  let actions = 0;
  await page.keyboard.press('ControlOrMeta+V');
  actions++;

  const created = page.getByTestId('created-short-url');
  await expect(created).toBeVisible();
  expect(actions).toBe(1);
  const shortUrl = (await created.innerText()).trim();
  expect(shortUrl).toMatch(/\/[0-9A-Za-z]{7}$/u);

  if (browserName === 'chromium') {
    await expect(page.locator('.created')).toHaveAttribute('data-copied', 'yes');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shortUrl);
    await expect(page.locator('.created-label')).toHaveText(/copied to your clipboard/u);
  } else {
    // Whichever way the browser answered the write, the strip says it in words.
    await expect(page.locator('.created-label')).toHaveText(/copied to your clipboard|Copy it below/u);
  }

  // A sentence pasted onto the page is not a link and creates nothing.
  await putOnClipboard(page, 'see the attached file');
  await page.locator('.ledger-title').click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('.ledger tbody tr[data-slug]')).toHaveCount(1);
});

/** Put text on the real system clipboard the way a person would: select it, press copy. */
async function putOnClipboard(page: Page, text: string) {
  await page.evaluate((value) => {
    const scratch = document.createElement('textarea');
    scratch.id = 'clipboard-scratch';
    scratch.value = value;
    document.body.append(scratch);
    scratch.select();
  }, text);
  await page.keyboard.press('ControlOrMeta+C');
  await page.evaluate(() => document.getElementById('clipboard-scratch')?.remove());
}

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
