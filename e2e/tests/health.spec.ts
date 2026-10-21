import { API_BASE_URL, expect, SHORT_BASE_URL, test } from '../fixtures';

const WORKER = process.env.WORKER_INTERNAL_URL ?? 'http://localhost:4100';

test.describe('every service answers /health with its dependencies checked', () => {
  for (const [name, base, deps] of [
    ['api', API_BASE_URL, ['postgres', 'redis']],
    ['redirect', SHORT_BASE_URL, ['postgres', 'redis']],
    ['click-worker', WORKER, ['geoip', 'postgres', 'redis']],
  ] as const) {
    test(name, async ({ request }) => {
      const response = await request.get(`${base}/health`);
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        service: string;
        status: string;
        checks: { name: string; status: string }[];
      };
      expect(body.service).toBe(name);
      expect(body.checks.map((c) => `${c.name}:${c.status}`).sort()).toEqual(
        deps.map((d) => `${d}:ok`),
      );
    });
  }
});

test('the /status page shows all three services up and the pipeline numbers', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByTestId('overall')).toHaveText(/Every service is up/u);
  for (const service of ['api', 'redirect', 'click-worker']) {
    await expect(page.locator(`[data-service="${service}"]`)).toContainText('Up');
  }
  await expect(page.getByText('Clicks stored')).toBeVisible();
});
