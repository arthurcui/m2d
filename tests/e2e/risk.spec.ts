import { test, expect } from '@playwright/test';
import {
  sevenAccountFixture,
  workbook,
} from '../../packages/ingestion/src/index.js';
import type { State } from '../../packages/portfolio/src/index.js';
test('stock/ETF risk, sale planning, payoff and saved watch-only plans preserve portfolio and drafts', async ({
  page,
  request,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Isolated writable fixture stack only',
  );
  let before = (await (await request.get('/api/v1/portfolio/overview')).json())
    .data;
  if (!before.state.accounts.length) {
    await page.goto('/portfolio');
    await page.getByLabel(/Excel workbook/).setInputFiles({
      name: 'risk-fixture.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await workbook(sevenAccountFixture()),
    });
    await page
      .getByRole('button', { name: 'Preview workbook', exact: true })
      .click();
    const preview = page.getByRole('region', { name: 'Confirmation preview' });
    await preview.getByRole('checkbox').check();
    await preview.getByRole('button', { name: 'Confirm changes' }).click();
    await expect(preview).toHaveCount(0);
    before = (await (await request.get('/api/v1/portfolio/overview')).json())
      .data;
  }
  const state = before.state as State,
    index = state.positions.findIndex(
      (p) => p.instrument.assetType !== 'OPTION' && Number(p.quantity) >= 1,
    );
  expect(index).toBeGreaterThanOrEqual(0);
  await page.goto('/risk');
  await expect(
    page.getByRole('heading', { name: 'Stocks, ETFs & options risk' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Stock / ETF trade' }).click();
  await page.getByLabel('Existing holding').selectOption(String(index));
  await page.getByLabel('Quantity / contracts').fill('2');
  await page.getByLabel('Entry or execution price').fill('200');
  await page.getByLabel('Total fees', { exact: true }).fill('1');
  await page.getByLabel('Stop price', { exact: true }).fill('190');
  await page.getByLabel('Target price', { exact: true }).fill('220');
  await page.getByLabel('Risk budget', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Analyze stock / ETF trade' }).click();
  await expect(page.getByText(/Risk at stop: 21/)).toBeVisible();
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await page.getByRole('link', { name: 'Options & Risk', exact: true }).click();
  await expect(page.getByLabel('Entry or execution price')).toHaveValue('200');
  await page.getByLabel('Proposed action').selectOption('SELL');
  await page.getByLabel('Quantity / contracts').fill('1');
  await page.getByRole('button', { name: 'Analyze stock / ETF trade' }).click();
  await expect(
    page.getByRole('heading', { name: 'Hypothetical sell' }),
  ).toBeVisible();
  await expect(page.getByText(/cash change 199/)).toBeVisible();
  await page.getByRole('tab', { name: 'Strategy payoff' }).click();
  await page.getByLabel('Estimated total slippage').fill('0');
  await page.getByRole('button', { name: 'Calculate payoff' }).click();
  await expect(
    page.getByRole('img', {
      name: 'Hypothetical profit and loss by underlying price',
    }),
  ).toBeVisible();
  await page
    .getByText('Build a reviewable trade plan', { exact: true })
    .click();
  await page.getByLabel('Stock plan action').selectOption('SELL');
  await page
    .getByLabel('Entry condition', { exact: true })
    .fill('Reduce concentration after review');
  await page
    .getByLabel('Exit / profit-taking condition')
    .fill('Sell one owned share');
  await page
    .getByLabel('Invalidation condition')
    .fill('Reassess if thesis improves');
  await page
    .getByLabel('Main risk', { exact: true })
    .fill('Price recovers after sale');
  await page.getByLabel('I reviewed current holdings and cash').check();
  await page.getByRole('button', { name: 'Review plan', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Watch-only plan' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save hypothetical plan' }).click();
  await expect(
    page.getByText('Plan saved. No order or portfolio change.'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Saved plans' }).click();
  await expect(
    page
      .getByText(/historical assessment, not a current recommendation/)
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: '.tmp/m5-risk-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Stocks, ETFs & options risk' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: '.tmp/m5-risk-mobile.png', fullPage: true });
  expect(
    (await (await request.get('/api/v1/portfolio/overview')).json()).data,
  ).toEqual(before);
});
