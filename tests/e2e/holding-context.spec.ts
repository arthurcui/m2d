import { test, expect } from '@playwright/test';
import {
  instrumentKey,
  instrumentSchema,
} from '../../packages/portfolio/src/index.js';
test('select a holding, preserve context across navigation, and submit shorthand', async ({
  page,
}) => {
  const instrument = instrumentSchema.parse({
    assetType: 'STOCK',
    symbol: 'CRWV',
    exchange: 'NASDAQ',
    currency: 'USD',
    optionRight: null,
    expiry: null,
    strike: null,
    multiplier: '1',
    underlying: null,
    deliverable: null,
  });
  const state = {
    accounts: [
      {
        accountKey: 'tfsa',
        displayName: 'Questrade TFSA',
        institution: 'Questrade',
        accountType: 'TFSA',
        baseCurrency: 'USD',
        active: true,
        notes: '',
      },
    ],
    positions: [
      {
        accountKey: 'tfsa',
        instrument,
        quantity: '10',
        averageCost: '100',
        quality: 'BASELINE_ESTIMATE',
        description: 'CoreWeave Inc.',
      },
    ],
    cash: [{ accountKey: 'tfsa', currency: 'USD', balance: '500' }],
  };
  let sent: Record<string, unknown> | undefined;
  await page.route('**/api/v1/portfolio/overview', (r) =>
    r.fulfill({
      json: {
        data: {
          state,
          revision: 1,
          effectiveAt: null,
          baselineId: null,
          warnings: [],
        },
      },
    }),
  );
  await page.route('**/api/v1/portfolio/history', (r) =>
    r.fulfill({ json: { data: [] } }),
  );
  await page.route('**/api/v1/chat/sessions/*', (r) =>
    r.fulfill({
      json: { data: { revision: 1, draft: '', history: [], runs: [] } },
    }),
  );
  await page.route('**/api/v1/chat/sessions/*/runs', (r) => {
    sent = r.request().postDataJSON() as Record<string, unknown>;
    return r.fulfill({ json: { data: { id: 'mock', status: 'completed' } } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/portfolio');
  const choose = page.getByRole('button', {
    name: 'Discuss CRWV in Questrade TFSA with Agent',
  });
  await choose.click();
  await expect(choose).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.holding-context-chip')).toContainText(
    'CRWV · Questrade TFSA',
  );
  await page.reload();
  await expect(page.locator('.holding-context-chip')).toContainText('CRWV');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(page.locator('.holding-context-chip')).toContainText('CRWV');
  const input = page.getByLabel('Portfolio message');
  await input.fill('sold 3 shares');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(sent).toMatchObject({
    message: 'sold 3 shares',
    holdingContext: {
      accountKey: 'tfsa',
      instrumentKey: instrumentKey(instrument),
    },
  });
  const composer = page.locator('.agent-context:not([hidden]) .agent-composer');
  const panel = page.getByRole('complementary', { name: 'Agent', exact: true });
  expect(
    (await composer.boundingBox())!.y + (await composer.boundingBox())!.height,
  ).toBeLessThanOrEqual(
    (await panel.boundingBox())!.y + (await panel.boundingBox())!.height + 1,
  );
  await page.getByRole('button', { name: 'Clear selected holding' }).click();
  await expect(page.locator('.holding-context-chip')).toHaveCount(0);
  await expect(choose).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Search holdings').fill('no match');
  await expect(choose).toHaveCount(0);
  await page.getByLabel('Search holdings').fill('CRWV');
  await expect(choose).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(choose).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
