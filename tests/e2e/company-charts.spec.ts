import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('company charts use stored evidence, cite sources, retain selections and enforce historical boundaries', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Isolated fixture stack only.',
  );
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') writes.push(r.url());
  });
  await page.goto('/research');
  await page.getByLabel('Research ticker').fill('NVDA');
  const price = page.getByRole('article', { name: 'Price and events' });
  const finances = page.getByRole('article', { name: 'Financial trends' });
  await expect(price).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Load demo reports' }).click();
  await expect(
    finances.getByRole('group', { name: 'NVDA reported financial trend' }),
  ).toBeVisible({ timeout: 20000 });
  await expect(finances).toContainText('Synthetic figures');
  await finances.getByRole('button', { name: 'Explain this figure' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Research message', exact: true }),
  ).toHaveValue(/120000000 USD/);
  await finances.getByRole('button', { name: 'Open financial source' }).click();
  await expect(page.locator('#research-document')).toContainText('SYNTHETIC');
  await price
    .getByRole('button', { name: 'Refresh price history', exact: true })
    .click();
  await expect(
    price.getByRole('group', { name: 'NVDA historical hourly closes' }),
  ).toBeVisible();
  const id = randomUUID();
  const upload = await page.request.post('/api/v1/research/upload', {
    headers: { origin: new URL(page.url()).origin },
    data: {
      version: 1,
      idempotencyKey: id,
      symbol: 'NVDA',
      name: 'chart-event.txt',
      publishedAt: '2026-10-30T17:30:00Z',
      contentBase64: Buffer.from(
        'Synthetic event. Management raised its outlook; this is fictional evidence.',
      ).toString('base64'),
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/v1/research/imports/${id}`)
          ).json()
        ).data.status,
    )
    .toBe('completed');
  // A fresh company read discovers the newly stored source without a provider request.
  await page.getByLabel('Research ticker').fill('AAPL');
  await page.getByLabel('Research ticker').fill('NVDA');
  await expect(price).toContainText('1 publication marker');
  await price
    .getByRole('link', { name: 'Open event: chart-event.txt' })
    .click();
  await expect(page.locator('#research-document')).toContainText(
    'Synthetic event.',
  );
  await finances.getByLabel('Reporting period').selectOption('annual');
  await page
    .getByRole('link', { name: 'Portfolio', exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Research', exact: true })
    .first()
    .click();
  await expect(finances.getByLabel('Reporting period')).toHaveValue('annual');
  await finances.getByLabel('Reporting period').selectOption('quarter');
  await page.route('**/api/v1/market/refresh', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'Provider unavailable for test.' },
      }),
    }),
  );
  await price
    .getByRole('button', { name: 'Refresh price history', exact: true })
    .click();
  await expect(price.getByRole('alert')).toContainText('Provider unavailable');
  await expect(
    price.getByRole('group', { name: 'NVDA historical hourly closes' }),
  ).toBeVisible();
  await page.unroute('**/api/v1/market/refresh');
  await price.getByRole('button', { name: 'Reload stored history' }).click();
  await expect(price.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await price.screenshot({ path: '.tmp/company-price-desktop.png' });
  await finances.screenshot({ path: '.tmp/company-financial-desktop.png' });
  await page.getByRole('button', { name: 'Close Agent' }).click();
  await page.setViewportSize({ width: 390, height: 1400 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await price.screenshot({ path: '.tmp/company-price-mobile.png' });
  await finances.screenshot({ path: '.tmp/company-financial-mobile.png' });
  await page.getByLabel('Evidence available by (UTC)').fill('2020-01-01T00:00');
  await expect(price.getByRole('group')).toHaveCount(0);
  await expect(finances.getByRole('group')).toHaveCount(0);
  await expect(
    price.getByRole('button', { name: 'Refresh price history', exact: true }),
  ).toBeDisabled();
});
