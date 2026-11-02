import { test, expect, type Page } from '@playwright/test';
import {
  FixtureMarketProvider,
  valuePortfolio,
  type MarketSettings,
} from '../../packages/market/src/index.js';
import type { State } from '../../packages/portfolio/src/index.js';

async function setup(page: Page) {
  const instrument = {
    assetType: 'STOCK' as const,
    symbol: 'TSLA',
    exchange: 'NASDAQ',
    currency: 'USD',
    optionRight: null,
    expiry: null,
    strike: null,
    multiplier: '1',
    underlying: null,
    deliverable: null,
  };
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
    positions: [
      {
        accountKey: 'TEST',
        instrument,
        quantity: '3',
        averageCost: '100',
        quality: 'COMPLETE_LEDGER',
        notes: '',
        description: '',
      },
      {
        accountKey: 'TEST',
        instrument: {
          ...instrument,
          assetType: 'OPTION',
          underlying: 'TSLA',
          optionRight: 'CALL',
          expiry: '2026-12-18',
          strike: '400',
          multiplier: '100',
          deliverable: 'STANDARD',
        },
        quantity: '-1',
        averageCost: '5',
        quality: 'COMPLETE_LEDGER',
        notes: '',
        description: '',
      },
    ],
  };
  const result = await new FixtureMarketProvider().quote(instrument);
  if (result.payload.kind !== 'quote')
    throw new Error('Quote fixture required');
  const quote = result.payload.value;
  let settings: MarketSettings = {
    revision: 0,
    priceProvider: 'fixture',
    listingProvider: 'none',
    refreshSeconds: 0,
    providers: [
      {
        id: 'ibkr',
        label: 'IBKR',
        configured: false,
        listings: true,
        minimumRefreshSeconds: 15,
        priceDescription: 'IBKR subscriptions',
        listingDescription: 'Descriptions; no logos',
      },
      {
        id: 'massive',
        label: 'Massive Basic',
        configured: true,
        listings: true,
        minimumRefreshSeconds: 60,
        priceDescription: 'End-of-day prices, not live.',
        listingDescription: 'Names and logos',
      },
      {
        id: 'twelvedata',
        label: 'Twelve Data',
        configured: false,
        listings: false,
        minimumRefreshSeconds: 60,
        priceDescription: 'Options unavailable',
        listingDescription: '',
      },
      {
        id: 'fixture',
        label: 'Offline fixtures',
        configured: true,
        listings: true,
        minimumRefreshSeconds: 15,
        priceDescription: 'Synthetic prices',
        listingDescription: 'Synthetic names',
      },
    ],
  };
  const requests: string[] = [];
  const loaded = new Set<string>();
  let failed = false;
  let hold: Promise<void> | null = null;
  let release = () => {};
  await page.clock.install({ time: new Date('2026-11-01T03:59:00Z') });
  await page.clock.pauseAt(new Date('2026-11-01T04:00:00Z'));
  await page.route('**/api/v1/portfolio/overview', (route) =>
    route.fulfill({
      json: {
        data: {
          revision: 1,
          effectiveAt: null,
          baselineId: null,
          state,
          warnings: [],
        },
      },
    }),
  );
  await page.route('**/api/v1/portfolio/listings', (route) =>
    route.fulfill({
      json: {
        data: {
          provider: settings.listingProvider,
          configured: false,
          listings: {},
          requests: [],
        },
      },
    }),
  );
  await page.route('**/api/v1/market/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Partial<MarketSettings>;
      if (input.revision !== settings.revision)
        return route.fulfill({
          status: 409,
          json: { error: { message: 'Settings changed; retry.' } },
        });
      settings = {
        ...settings,
        ...input,
        refreshSeconds:
          input.refreshSeconds ??
          (input.priceProvider && input.priceProvider !== settings.priceProvider
            ? 0
            : settings.refreshSeconds),
        revision: settings.revision + 1,
      };
    }
    return route.fulfill({ json: { data: settings } });
  });
  await page.route('**/api/v1/portfolio/valuation', (route) =>
    route.fulfill({
      json: {
        data: {
          ...valuePortfolio(
            state,
            loaded.has(settings.priceProvider)
              ? [
                  {
                    ...quote,
                    provider: settings.priceProvider,
                    last:
                      settings.priceProvider === 'massive'
                        ? '510.25'
                        : '420.12',
                    bid: null,
                    ask: null,
                    kind:
                      settings.priceProvider === 'massive'
                        ? 'EOD_CLOSE'
                        : 'REGULAR_CLOSE',
                    quality:
                      settings.priceProvider === 'massive'
                        ? 'DELAYED'
                        : 'FIXTURE',
                  },
                ]
              : [],
            [],
            'USD',
            new Date().toISOString(),
          ),
          provider: settings.priceProvider,
          portfolioRevision: 1,
          refreshIntervalMs: 0,
          requests: [{ kind: 'quote', instrument }],
        },
      },
    }),
  );
  await page.route('**/api/v1/market/refresh', async (route) => {
    const request = route.request().postDataJSON() as {
      expectedProvider: string;
    };
    requests.push(request.expectedProvider);
    if (hold) await hold;
    if (!failed) loaded.add(request.expectedProvider);
    return route.fulfill({
      json: {
        data: {
          status: failed ? 'FAILED' : 'SUCCEEDED',
          errorCode: failed ? 'NETWORK_UNAVAILABLE' : null,
        },
      },
    });
  });
  await page.goto('/portfolio');
  const controls = page
    .getByRole('region', { name: 'Portfolio price settings' })
    .filter({ visible: true });
  await expect(
    controls.getByRole('combobox', { name: 'Price provider', exact: true }),
  ).toHaveValue('fixture');
  await expect(
    controls.getByRole('button', { name: 'Refresh prices now' }),
  ).toBeEnabled();
  return {
    bumpAnalysisRevision: () => {
      settings = { ...settings, revision: settings.revision + 1 };
    },
    controls,
    requests,
    settings: () => settings,
    setFailure: (value: boolean) => {
      failed = value;
    },
    block: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
      hold = null;
    },
  };
}

test('separate providers auto-save; market marks match full contracts and stay separate from cost', async ({
  page,
}, testInfo) => {
  const { controls, requests, bumpAnalysisRevision } = await setup(page);
  const table = page.getByRole('table', { name: 'Example account holdings' });
  const rows = table.locator('tbody tr');
  expect(requests).toEqual([]);
  await expect(
    controls.getByRole('combobox', { name: 'Price refresh', exact: true }),
  ).toHaveValue('0');
  await controls.getByRole('button', { name: 'Refresh prices now' }).click();
  await expect(rows.first().locator('.holding-market-price')).toContainText(
    '420.12',
  );
  await expect(rows.nth(1).locator('.holding-market-price')).toContainText(
    'Unavailable',
  );
  await expect(rows.first().locator('td').nth(1)).toContainText('100');
  await rows.first().locator('.holding-price-evidence summary').click();
  await expect(rows.first()).toContainText('Source: fixture');
  await expect(rows.first()).toContainText('As of:');
  await expect(controls).toContainText('Refresh finished');
  bumpAnalysisRevision();
  await controls
    .getByRole('combobox', { name: 'Price provider', exact: true })
    .selectOption('massive');
  await expect(rows.first().locator('.holding-market-price')).toContainText(
    'Unavailable',
  );
  await controls
    .getByRole('combobox', { name: 'Listing details provider' })
    .selectOption('fixture');
  await expect(
    controls.getByRole('combobox', { name: 'Price provider', exact: true }),
  ).toHaveValue('massive');
  await controls.getByRole('button', { name: 'Refresh prices now' }).click();
  await expect(rows.first().locator('.holding-market-price')).toContainText(
    '510.25',
  );
  await expect(rows.first().locator('.holding-market-price')).toContainText(
    'EOD close',
  );
  expect(requests).toEqual(['fixture', 'massive']);
  await page.reload();
  await expect(
    controls.getByRole('combobox', { name: 'Price provider', exact: true }),
  ).toHaveValue('massive');
  await expect(
    controls.getByRole('combobox', { name: 'Listing details provider' }),
  ).toHaveValue('fixture');
  await rows.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('desktop-holdings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first().locator('.holding-market-price')).toBeVisible();
  expect(
    (await rows.first().locator('.holding-market-price').boundingBox())!.width,
  ).toBeGreaterThan(60);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Close Advisor' }).click();
  await rows.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mobile-holdings.png') });
});

test('automatic price refresh counts down, pauses on navigation, and manual mode cancels it', async ({
  page,
}) => {
  const { controls, requests } = await setup(page);
  await controls
    .getByRole('combobox', { name: 'Price refresh', exact: true })
    .selectOption('15');
  await expect(controls).toContainText('Refreshes in 15 seconds');
  await page.clock.runFor(14000);
  await expect(controls).toContainText('Refreshes in 1 second');
  expect(requests).toHaveLength(0);
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await page.clock.runFor(60000);
  expect(requests).toHaveLength(0);
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(
    controls.getByRole('combobox', { name: 'Price refresh', exact: true }),
  ).toHaveValue('15');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(30000);
  expect(requests).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(controls).toContainText('Refreshes in 15 seconds');
  await page.clock.runFor(15000);
  await expect.poll(() => requests.length).toBe(1);
  await expect(controls).toContainText('Refresh finished');
  await controls
    .getByRole('combobox', { name: 'Price refresh', exact: true })
    .selectOption('0');
  await expect(controls).toContainText('Manual refresh');
  await page.clock.runFor(60000);
  expect(requests).toHaveLength(1);
});

test('automatic refresh never overlaps a slow batch and pauses after a provider error', async ({
  page,
}) => {
  const task = await setup(page);
  task.block();
  await task.controls
    .getByRole('combobox', { name: 'Price refresh', exact: true })
    .selectOption('15');
  await expect(task.controls).toContainText('Refreshes in 15 seconds');
  await page.clock.runFor(15000);
  await expect.poll(() => task.requests.length).toBe(1);
  await page.clock.runFor(60000);
  expect(task.requests).toHaveLength(1);
  await expect(
    task.controls.getByRole('button', { name: 'Refresh prices now' }),
  ).toBeDisabled();
  task.release();
  await expect(task.controls).toContainText('Refresh finished');
  task.setFailure(true);
  await page.clock.runFor(15000);
  await expect.poll(() => task.requests.length).toBe(2);
  await expect(task.controls).toContainText('Auto-refresh paused');
  await page.clock.runFor(120000);
  expect(task.requests).toHaveLength(2);
  task.setFailure(false);
  await task.controls
    .getByRole('button', { name: 'Refresh prices now' })
    .click();
  await expect.poll(() => task.requests.length).toBe(3);
  await expect(task.controls).toContainText('Refreshes in 15 seconds');
});

test('switching provider during a refresh does not label its late response as the new source', async ({
  page,
}) => {
  const task = await setup(page);
  task.block();
  await task.controls
    .getByRole('button', { name: 'Refresh prices now' })
    .click();
  await expect.poll(() => task.requests.length).toBe(1);
  await task.controls
    .getByRole('combobox', { name: 'Price provider', exact: true })
    .selectOption('massive');
  await expect(
    task.controls.getByRole('combobox', {
      name: 'Price provider',
      exact: true,
    }),
  ).toHaveValue('massive');
  task.release();
  await expect(task.controls).toContainText('Refresh stopped');
  const mark = page
    .getByRole('table', { name: 'Example account holdings' })
    .locator('tbody tr')
    .first()
    .locator('.holding-market-price');
  await expect(mark).toContainText('Unavailable');
  await task.controls
    .getByRole('button', { name: 'Refresh prices now' })
    .click();
  await expect(mark).toContainText('510.25');
  expect(task.requests).toEqual(['fixture', 'massive']);
});
