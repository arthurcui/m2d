import { test, expect } from '@playwright/test';
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
