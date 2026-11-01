import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('research imports, compares, searches and keeps its state and cited Agent discussion across navigation', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Uses the isolated writable fixture stack only.',
  );
  const symbol = `M4${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  await page.goto('/research');
  await page
    .getByRole('button', { name: 'Reset conversation', exact: true })
    .click();
  await page.getByLabel('Research ticker').fill(symbol);
  await page.getByRole('button', { name: 'Load demo reports' }).click();
  const reports = page.locator('.research-documents .research-card');
  await expect(reports).toHaveCount(2, { timeout: 20000 });
  await reports.nth(1).getByRole('button', { name: 'Use as before' }).click();
  await reports.nth(0).getByRole('button', { name: 'Use as after' }).click();
  await page.getByRole('button', { name: 'Compare selected reports' }).click();
  await expect(
    page.getByRole('region', { name: 'Report comparison' }),
  ).toContainText('Customer concentration');
  await page.getByLabel('Search stored evidence').fill('concentration');
  await page
    .getByRole('button', { name: 'Search documents', exact: true })
    .click();
  await expect(page.locator('.research-page')).toContainText('Available');
  await page
    .getByRole('link', { name: 'Portfolio', exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Research', exact: true })
    .first()
    .click();
  await expect(page.getByLabel('Research ticker')).toHaveValue(symbol);
  await expect(
    page.getByRole('region', { name: 'Report comparison' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Discuss with Agent', exact: true })
    .click();
  const message = page.getByRole('textbox', {
    name: 'Research message',
    exact: true,
  });
  await expect(message).toHaveValue(/Review the stored research/);
  await message.press('Enter');
  await expect(
    page
      .locator('.agent-message')
      .filter({ hasText: 'Synthetic fixture research.' }),
  ).toBeVisible({ timeout: 20000 });
  const citation = page
    .locator('.agent-message a[href^="/research?document="]')
    .last();
  await citation.click();
  await expect(page.locator('#research-document')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download preserved original' }),
  ).toBeVisible();
  await page.getByLabel('Evidence available by (UTC)').fill('2020-01-01T00:00');
  await expect(reports).toHaveCount(0);
  await page.getByRole('button', { name: 'Current view' }).click();
  await expect(reports).toHaveCount(2);
  await page.getByLabel('Upload a company or fund document').setInputFiles({
    name: 'issuer-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Management expects a stronger revenue outlook. Customer concentration remains a material risk.',
    ),
  });
  await page
    .getByRole('button', { name: 'Upload document', exact: true })
    .click();
  await expect(reports).toHaveCount(3, { timeout: 20000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Research', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
