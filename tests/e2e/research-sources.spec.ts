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
    .getByRole('button', { name: 'New conversation', exact: true })
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
  await library.locator('> summary').click();
  await expect(library).toContainText('Offline source mode');
  await library
    .getByText('Add a company, fund, notice or feed link', { exact: true })
    .click();
  await library
    .getByLabel('Source name', { exact: true })
    .fill('My company reports');
  await library
    .getByLabel('Public document or feed URL')
    .fill('https://example.com/reports');
  await library
    .getByRole('button', { name: 'Save source', exact: true })
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
    name: 'Discovered source documents',
  });
  await expect(found).toContainText('synthetic report PDF');
  await found.getByRole('button', { name: 'Import document' }).click();
  await expect(page.locator('.research-documents .research-card')).toHaveCount(
    1,
    { timeout: 20000 },
  );
  await library.getByLabel('Source name', { exact: true }).fill('Invalid URL');
  await library
    .getByLabel('Public document or feed URL')
    .fill('http://localhost/private');
  await library
    .getByRole('button', { name: 'Save source', exact: true })
    .click();
  await expect(library.getByRole('alert')).toContainText('public HTTPS');
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
