import { test, expect } from '@playwright/test';
import type { Valuation } from '../../packages/market/src/index.js';
test.beforeEach(async ({ page }, testInfo) => {
  if (!testInfo.title.startsWith('market fixtures')) {
    const settings = (
      await (await page.request.get('/api/v1/market/settings')).json()
    ).data;
    await page.route('**/api/v1/market/settings', (route) =>
      route.fulfill({
        json: {
          data: {
            ...settings,
            priceProvider: 'massive',
            listingProvider: 'none',
            refreshSeconds: 0,
          },
        },
      }),
    );
  }
  await page.route('**/api/v1/portfolio/listings', (route) =>
    route.fulfill({
      json: {
        data: {
          provider: 'none',
          configured: false,
          listings: {},
          requests: [],
        },
      },
    }),
  );
});
type ValuationView = Valuation & {
  provider: string;
  portfolioRevision: number;
};

test('portfolio refresh shows partial values immediately and continues past an unavailable holding', async ({
  page,
}) => {
  const base = (
    (await (await page.request.get('/api/v1/portfolio/valuation')).json()) as {
      data: ValuationView;
    }
  ).data;
  const requests = ['OPEN', 'MISSING', 'TSLA'].map((symbol) => ({
    kind: 'quote' as const,
    instrument: {
      assetType: 'STOCK' as const,
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
  }));
  let subtotal = '0';
  const sent: string[] = [];
  let finish = () => {};
  const last = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/v1/portfolio/valuation', (route) =>
    route.fulfill({
      json: {
        data: {
          ...base,
          provider: 'massive',
          nav: null,
          knownValue: subtotal,
          refreshIntervalMs: 0,
          requests,
        },
      },
    }),
  );
  await page.route('**/api/v1/market/refresh', async (route) => {
    const symbol = (
      route.request().postDataJSON() as {
        request: { instrument: { symbol: string } };
      }
    ).request.instrument.symbol;
    sent.push(symbol);
    if (symbol === 'MISSING')
      return route.fulfill({
        json: { data: { status: 'FAILED', errorCode: 'NO_COVERAGE' } },
      });
    if (symbol === 'TSLA') await last;
    subtotal = symbol === 'OPEN' ? '123.45' : '543.21';
    await route.fulfill({
      json: { data: { status: 'SUCCEEDED', errorCode: null } },
    });
  });
  await page.goto('/market');
  const panel = page.getByRole('region', {
    name: 'Portfolio valuation',
    exact: true,
  });
  await panel.getByRole('button', { name: 'Refresh portfolio prices' }).click();
  try {
    await expect.poll(() => sent.length).toBe(3);
    await expect(panel).toContainText('123.45 USD');
    await expect(panel).toContainText('Refreshing TSLA · 3 of 3 sources');
    await expect(panel).not.toContainText('(UNKNOWN)');
    await expect(panel.getByRole('alert')).toContainText('MISSING');
    await expect(panel.getByRole('alert')).toContainText('No price available');
  } finally {
    finish();
  }
  await expect(panel).toContainText('Refresh finished. 2 of 3 sources');
  await expect(panel).toContainText('543.21 USD');
  expect(sent).toEqual(['OPEN', 'MISSING', 'TSLA']);
});

test('portfolio refresh stops clearly on a provider-wide access failure', async ({
  page,
}) => {
  const base = (
    (await (await page.request.get('/api/v1/portfolio/valuation')).json()) as {
      data: ValuationView;
    }
  ).data;
  const instrument = {
    assetType: 'STOCK',
    symbol: 'OPEN',
    exchange: 'UNKNOWN',
    currency: 'USD',
    optionRight: null,
    expiry: null,
    strike: null,
    multiplier: '1',
    underlying: null,
    deliverable: null,
  };
  let calls = 0;
  await page.route('**/api/v1/portfolio/valuation', (route) =>
    route.fulfill({
      json: {
        data: {
          ...base,
          provider: 'massive',
          requests: [
            { kind: 'quote', instrument },
            { kind: 'quote', instrument: { ...instrument, symbol: 'TSLA' } },
          ],
        },
      },
    }),
  );
  await page.route('**/api/v1/market/refresh', (route) => {
    calls++;
    return route.fulfill({
      json: {
        data: { status: 'FAILED', errorCode: 'MARKET_ENTITLEMENT_REQUIRED' },
      },
    });
  });
  await page.goto('/market');
  const panel = page.getByRole('region', {
    name: 'Portfolio valuation',
    exact: true,
  });
  await panel.getByRole('button', { name: 'Refresh portfolio prices' }).click();
  await expect(panel).toContainText(
    'Refresh stopped after 0 successful sources',
  );
  await expect(panel.getByRole('alert')).toContainText(
    'Check the key and data plan',
  );
  await expect(
    panel.getByRole('button', { name: 'Refresh portfolio prices' }),
  ).toBeEnabled();
  expect(calls).toBe(1);
});
test('Massive Basic explains EOD coverage and disables unsupported chain refresh', async ({
  page,
}) => {
  await page.route('**/api/v1/market/status', (route) =>
    route.fulfill({
      json: {
        data: {
          provider: 'massive',
          configured: true,
          session: 'CLOSED',
          options:
            'Basic: individual option end-of-day closes via portfolio refresh; no chain snapshots, bid/ask or Greeks.',
          description: 'Massive Basic · end-of-day data, not live quotes.',
        },
      },
    }),
  );
  await page.goto('/market');
  const panel = page.getByRole('region', { name: 'Market data', exact: true });
  await expect(panel).toContainText('end-of-day data, not live quotes');
  await expect(
    panel.getByRole('button', { name: 'Refresh options' }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: 'Refresh quote', exact: true }),
  ).toBeEnabled();
  let requestedClass = '';
  await page.route('**/api/v1/market/refresh', (route) => {
    requestedClass = (
      route.request().postDataJSON() as {
        request: { instrument: { assetType: string } };
      }
    ).request.instrument.assetType;
    return route.fulfill({
      json: { data: { status: 'SUCCEEDED', errorCode: null } },
    });
  });
  await panel.getByLabel('Asset class').selectOption('ETF');
  const quoteRead = page.waitForResponse(
    (r) =>
      r.url().includes('/market/quotes?') && r.url().includes('assetType=ETF'),
  );
  await panel
    .getByRole('button', { name: 'Refresh quote', exact: true })
    .click();
  expect((await quoteRead).status()).toBe(200);
  expect(requestedClass).toBe('ETF');
});
test('market fixtures show provenance, OHLCV, missing Greeks and valuation coverage', async ({
  page,
}) => {
  await page.goto('/market');
  const panel = page.getByRole('region', { name: 'Market data', exact: true });
  await expect(panel).toContainText('Offline synthetic examples');
  await panel
    .getByRole('button', { name: 'Refresh quote', exact: true })
    .click();
  await expect(panel).toContainText('REGULAR_CLOSE');
  await expect(panel).toContainText('WATCH_ONLY');
  await panel.getByRole('button', { name: 'Refresh chart' }).click();
  await expect(
    panel.getByRole('img', { name: 'TSLA hourly OHLCV chart' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Refresh options' }).click();
  await expect(panel).toContainText('IV unavailable');
  const chat = page.getByRole('region', {
    name: /^Market.* chat$/,
    exact: true,
  });
  await chat
    .getByRole('textbox', { name: /^Market.* message$/ })
    .fill('What is my portfolio valuation?');
  await chat
    .getByRole('textbox', { name: /^Market.* message$/ })
    .press('Enter');
  await expect(chat.getByRole('log')).toContainText(
    'Stored portfolio valuation',
  );
  const valuation = page
    .getByRole('region', { name: 'Portfolio valuation', exact: true })
    .filter({ visible: true });
  await valuation
    .getByRole('button', { name: 'Refresh portfolio prices' })
    .click();
  await expect(valuation).toContainText('Refresh finished');
  await valuation
    .getByRole('button', { name: 'Save valuation snapshot' })
    .click();
  await expect(valuation).toContainText('Valuation snapshot saved');
  await page.reload();
  await page.getByRole('button', { name: 'Load stored data' }).click();
  await expect(panel).toContainText('REGULAR_CLOSE');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('m3-market-mobile.png'),
    fullPage: true,
  });
});
