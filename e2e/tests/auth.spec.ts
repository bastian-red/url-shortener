import { expect, signIn, signUpFresh, test } from '../fixtures';

test('a new account starts with an empty ledger and can sign out and back in', async ({ page }) => {
  const email = await signUpFresh(page, 'auth');
  await expect(page.getByText('No links yet. Paste one above to make your first.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/u);
  await signIn(page, email, 'a-long-enough-password');
  await expect(page.getByRole('heading', { name: 'Your links' })).toBeVisible();
});

test('a deep link survives the sign-in detour', async ({ page }) => {
  await page.goto('/status');
  await page.goto('/links/cnosuchlink00000000000000?range=30d');
  await page.waitForURL(/\/sign-in\?next=/u);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('next') ?? '')).toBe(
    '/links/cnosuchlink00000000000000?range=30d',
  );
});

test('a wrong password says so without saying which half was wrong', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('demo@links.test');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.form-error')).toHaveText(
    'That email address and password do not match.',
  );
});
