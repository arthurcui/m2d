import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('a pending conversation reset cannot erase the next message', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Requires isolated fixture stack.',
  );
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/chat/sessions/research/reset', async (route) => {
    const response = await route.fetch();
    await waiting;
    await route.fulfill({ response });
  });
  await page.goto('/research');
  const agent = page.getByRole('complementary', { name: 'Agent' });
  await agent
    .getByRole('button', { name: 'Reset conversation', exact: true })
    .click();
  await expect(agent.getByLabel('Research message')).toBeDisabled();
  release();
  await expect(agent.getByLabel('Research message')).toBeEnabled();
  await agent
    .getByLabel('Research message')
    .fill('Keep my next research question');
  await agent.getByLabel('Research message').press('Enter');
  await expect(agent.getByRole('log')).toContainText(
    'Keep my next research question',
  );
});
test('saved research sources survive navigation, import with citations and show local validation', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Requires isolated fixture stack.',
  );
  const symbol = `SRC${randomUUID().slice(0, 8).toUpperCase()}`;
  await page.goto('/research');
  await page.getByLabel('Research ticker').fill(symbol);
  const library = page.locator('.research-sources');
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await page.getByRole('button', { name: 'From URL', exact: true }).click();
  await expect(library).toContainText('Offline source mode');

  await library
    .getByLabel('Source name', { exact: true })
    .fill('My company reports');
  await library
    .getByLabel('Public document or feed URL')
    .fill('https://example.com/reports');
  await library
    .getByRole('button', { name: 'Save source', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suggested sources', exact: true })
    .click();
  const card = library
    .locator('.research-source-card')
    .filter({ has: page.getByRole('heading', { name: 'My company reports' }) });
  await expect(card).toBeVisible();
  await page
    .getByRole('link', { name: 'Portfolio', exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Research', exact: true })
    .first()
    .click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Browse documents' }).click();
  const found = page.getByRole('region', {
    name: 'Documents from My company reports',
  });
  await expect(found).toContainText('synthetic report PDF');
  await found.getByRole('button', { name: 'Import document' }).click();
  await expect(page.locator('.research-documents .research-card')).toHaveCount(
    1,
    { timeout: 20000 },
  );
  await page.getByRole('button', { name: 'From URL', exact: true }).click();
  await library.getByLabel('Source name', { exact: true }).fill('Invalid URL');
  await library
    .getByLabel('Public document or feed URL')
    .fill('http://localhost/private');
  await library
    .getByRole('button', { name: 'Save source', exact: true })
    .click();
  await expect(library.getByRole('alert')).toContainText('public HTTPS');
  await page
    .getByRole('button', { name: 'Suggested sources', exact: true })
    .click();
  await page.getByText('Historical view', { exact: true }).click();
  await page.getByLabel('Evidence available by (UTC)').fill('2020-01-01T00:00');
  await expect(
    card.getByRole('button', { name: 'Import page / feed' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Current view' }).click();
  await card.getByRole('button', { name: 'Remove link' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.research-documents .research-card')).toHaveCount(
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(library).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test('analyst upload preserves labelled opinions and prepares a cited comparison question', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Fixture stack only.',
  );
  await page.goto('/research');
  await page
    .getByLabel('Research ticker')
    .fill('AR' + randomUUID().slice(0, 8).toUpperCase());
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await page.getByLabel('Document category').selectOption('analyst');
  await page.getByLabel('Upload a company or fund document').setInputFiles({
    name: 'analyst.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Publisher: Synthetic Bank\nRating: Buy\nPrice target: $200\nRisks: Demand might decline.',
    ),
  });
  await page
    .getByRole('button', { name: 'Upload document', exact: true })
    .click();
  const card = page.locator('.research-documents .research-card');
  await expect(card).toHaveCount(1, { timeout: 20000 });
  await page.getByRole('button', { name: 'Close add research' }).click();
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await card.getByRole('button', { name: 'analyst.txt' }).click();
  const details = page.getByRole('region', { name: 'Analyst report details' });
  await expect(details).toContainText('Price target: $200');
  await expect(details).toContainText('Unknown');
  await details
    .getByRole('button', {
      name: 'Analyze / compare analyst reports with Agent',
    })
    .click();
  await expect(page.getByLabel('Research message')).toHaveValue(
    /Mark missing fields unknown/,
  );
});
