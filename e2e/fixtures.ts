/**
 * Shared E2E helpers.
 *
 * The seeded facts are read out of `packages/db/prisma/seed.mts` rather than
 * retyped, so a renamed seed link fails here with a sentence instead of every
 * spec failing with "element not found".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

const SEED = readFileSync(join(__dirname, '..', 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');

function seedConst(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']*)';`, 'm').exec(SEED);
  if (!match) throw new Error(`Could not read ${name} out of packages/db/prisma/seed.mts.`);
  return match[1]!;
}

export const DEMO_EMAIL = seedConst('DEMO_EMAIL');
export const DEMO_PASSWORD = seedConst('DEMO_PASSWORD');
export const HERO_SLUG = seedConst('HERO_SLUG');
export const HERO_URL = seedConst('HERO_URL');
export const HERO_TITLE = seedConst('HERO_TITLE');

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
export const SHORT_BASE_URL = process.env.SHORT_BASE_URL ?? 'http://localhost:8080';

/** London in MaxMind's test database, which the E2E lane's worker reads. */
export const LONDON = '81.2.69.160';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * One visit to a short link, as a phone behind one proxy hop would make it.
 * Not followed: the assertion is on the redirect itself.
 */
export async function visit(
  request: APIRequestContext,
  slug: string,
  options: { address?: string; referer?: string } = {},
) {
  return request.get(`${SHORT_BASE_URL}/${slug}`, {
    maxRedirects: 0,
    headers: {
      'x-forwarded-for': options.address ?? randomAddress(),
      'user-agent': IPHONE,
      ...(options.referer === undefined ? {} : { referer: options.referer }),
    },
  });
}

export async function signIn(
  page: Page,
  email = DEMO_EMAIL,
  password = DEMO_PASSWORD,
  next?: string,
) {
  await page.goto(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/** A new account, so a spec that creates links never shares a ledger with another. */
export async function signUpFresh(page: Page, label: string): Promise<string> {
  const email = `${label}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@links.test`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(label);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  return email;
}

/** The hero link's id, read from its row in the ledger. */
export async function heroId(page: Page): Promise<string> {
  await page.goto('/');
  const href = await page
    .getByRole('link', { name: HERO_TITLE, exact: true })
    .first()
    .getAttribute('href');
  const id = /\/links\/([a-z0-9]+)/u.exec(href ?? '')?.[1];
  if (id === undefined) throw new Error(`no link page for ${HERO_TITLE}`);
  return id;
}

/** Create a link through the command bar; returns its short URL and page path. */
export async function shorten(
  page: Page,
  url: string,
  slug?: string,
): Promise<{ shortUrl: string; path: string }> {
  await page.goto('/');
  await page.getByLabel('Destination URL').fill(url);
  if (slug !== undefined) {
    await page.getByText('Custom slug, title, expiry and click limit').click();
    await page.getByLabel('Custom slug').fill(slug);
  }
  await page.getByRole('button', { name: 'Shorten', exact: true }).click();
  const created = page.getByTestId('created-short-url');
  await expect(created).toBeVisible();
  const shortUrl = (await created.innerText()).trim();
  const path = (await page.locator('.created a.slug-pill').getAttribute('href')) ?? '';
  return { shortUrl, path };
}

/**
 * Every spec fails on an uncaught error in the page.
 *
 * Without it a client component can throw on every render, leave a blank region
 * behind, and the spec still passes because the element it asserts on was
 * rendered by the server. Auto-applied, so no spec can forget it.
 */
export const test = base.extend<{ failOnPageError: void }>({
  failOnPageError: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
