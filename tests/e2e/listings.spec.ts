import { test, expect } from '@playwright/test';
import type { State } from '../../packages/portfolio/src/index.js';
const state: State = {
  accounts: [
    {
      accountKey: 'TEST',
      displayName: 'Example account',
      institution: '',
      accountType: 'TFSA',
      baseCurrency: 'USD',
      active: true,
      notes: '',
    },
  ],
  cash: [],
  positions: ['GOOGL', 'TSLL', 'NBIS'].map((symbol) => ({
    accountKey: 'TEST',
    quantity: '3',
    averageCost: '100',
    quality: 'COMPLETE_LEDGER',
    description: 'STOCK',
    notes: '',
    instrument: {
      assetType: symbol === 'TSLL' ? 'ETF' : 'STOCK',
      symbol,
      exchange: 'UNKNOWN',
      currency: 'USD',
      optionRight: null,
      expiry: null,
      strike: null,
      multiplier: '1',
      underlying: null,
      deliverable: null,
    },
  })),
};
test('holdings use listing names and cached logos, search names and handle missing/broken icons', async ({
  page,
}) => {
  let providerWrites = 0;
  page.on('request', (r) => {
    if (r.url().includes('/market/refresh')) providerWrites++;
  });
  await page.route('**/api/v1/portfolio/overview', (route) =>
    route.fulfill({
      json: {
        data: {
          revision: 1,
          effectiveAt: null,
          baselineId: null,
          warnings: [],
          state,
        },
      },
    }),
  );
  const profile = (
    symbol: string,
    name: string,
    assetType: string,
    logoUrl: string,
  ) => ({
    id: symbol,
    lookup: { symbol, exchange: 'UNKNOWN', currency: 'USD', assetType },
    name,
    exchange: 'XNAS',
    assetType,
    provider: 'massive',
    asOf: '2026-10-31T18:00:00Z',
    logoIssue: null,
    logoUrl,
  });
  await page.route('**/api/v1/portfolio/listings', (route) =>
    route.fulfill({
      json: {
        data: {
          provider: 'massive',
          configured: true,
          requests: [],
          listings: {
            'GOOGL:UNKNOWN:USD:STOCK': profile(
              'GOOGL',
              'Alphabet Inc. Class A Common Stock',
              'STOCK',
              '/api/v1/market/listings/11111111-1111-4111-8111-111111111111/logo',
            ),
            'TSLL:UNKNOWN:USD:ETF': profile(
              'TSLL',
              'Direxion Daily TSLA Bull 2X Shares',
              'ETF',
              '/api/v1/market/listings/22222222-2222-4222-8222-222222222222/logo',
            ),
          },
        },
      },
    }),
  );
  await page.route('**/api/v1/market/listings/*/logo', (route) =>
    route.request().url().includes('11111111')
      ? route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><circle cx="15" cy="15" r="12" fill="#23584a"/></svg>',
        })
      : route.fulfill({ status: 404, body: '' }),
  );
  await page.goto('/portfolio');
  const table = page.getByRole('table', { name: 'Example account holdings' });
  await expect(table).toContainText('Alphabet Inc. Class A Common Stock');
  await expect(table).toContainText('Direxion Daily TSLA Bull 2X Shares');
  await expect(table).toContainText('Listing name unavailable');
  await expect(table.getByText('STOCK', { exact: true })).toHaveCount(0);
  await expect(
    table.getByRole('img', { name: 'Alphabet Inc. Class A Common Stock logo' }),
  ).toBeVisible();
  await expect(
    table.locator('.security-logo[title*="logo unavailable"]'),
  ).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Search holdings' }).fill('Alphabet');
  await expect(table).toContainText('GOOGL');
  await expect(table).not.toContainText('TSLL');
  await page.getByRole('textbox', { name: 'Search holdings' }).fill('');
  expect(providerWrites).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await table
    .getByRole('img', { name: 'Alphabet Inc. Class A Common Stock logo' })
    .scrollIntoViewIfNeeded();
  await expect(
    table.getByRole('img', { name: 'Alphabet Inc. Class A Common Stock logo' }),
  ).toBeVisible();
  await expect(
    table.locator('.security-logo[title*="logo unavailable"]'),
  ).toHaveCount(2);
  expect(
    (await table.locator('.security-identity').first().boundingBox())!.width,
  ).toBeGreaterThan(200);
  expect(
    (await table
      .locator('tbody tr')
      .first()
      .locator('td')
      .first()
      .boundingBox())!.width,
  ).toBeGreaterThan(60);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
