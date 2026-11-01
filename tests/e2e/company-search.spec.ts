import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('hybrid company search finds paraphrases, keeps filters and opens cited evidence on desktop and mobile', async ({
  page,
  request,
  baseURL,
}) => {
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Requires the isolated fixture stack.',
  );
  const symbol = `S${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  for (const [name, text] of [
    [
      'liquidity.txt',
      'Existing liquidity supports six months of operations. Management is seeking additional funding.',
    ],
    [
      'revenue.txt',
      'Revenue increased by 20 percent. Management maintained the annual outlook.',
    ],
  ]) {
    const id = randomUUID();
    const response = await request.post('/api/v1/research/upload', {
      headers: { origin: new URL(baseURL!).origin },
      data: {
        version: 1,
        symbol,
        name,
        contentBase64: Buffer.from(text!).toString('base64'),
        idempotencyKey: id,
      },
    });
    expect(response.status()).toBe(202);
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/v1/research/imports/${id}`)).json())
            .data.status,
      )
      .toBe('completed');
  }
  await page.goto('/research');
  await page
    .getByRole('button', { name: 'Reset conversation', exact: true })
    .click();
  await page.getByLabel('Research ticker').fill(symbol);
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  const search = page.getByRole('region', { name: 'Company evidence search' });
  await search.getByText('Search options', { exact: true }).click();
  await search.getByLabel('Search method').selectOption('keyword');
  await search
    .getByLabel('Search stored evidence')
    .fill('Could it run out of money?');
  await search
    .getByRole('button', { name: 'Search documents', exact: true })
    .click();
  await expect(search).toContainText('0 matching passages');
  await search.getByText('Search coverage', { exact: true }).click();
  await search
    .getByRole('button', { name: 'Build search index', exact: true })
    .click();
  await expect(search).toContainText('2 / 2 eligible passages indexed', {
    timeout: 20000,
  });
  await search.getByLabel('Search method').selectOption('hybrid');
  await search
    .getByRole('button', { name: 'Search documents', exact: true })
    .click();
  await expect(search.locator('.company-search-hit')).toHaveCount(1);
  await expect(search.locator('.company-search-hit')).toContainText(
    'Existing liquidity',
  );
  await expect(search).toContainText('Synthetic fixture embeddings');
  await page
    .getByRole('link', { name: 'Portfolio', exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Research', exact: true })
    .first()
    .click();
  await expect(search.getByLabel('Search method')).toHaveValue('hybrid');
  await expect(search.getByLabel('Search stored evidence')).toHaveValue(
    'Could it run out of money?',
  );
  await search.getByRole('button', { name: 'Ask Agent about results' }).click();
  const message = page.getByRole('textbox', {
    name: 'Research message',
    exact: true,
  });
  await expect(message).toHaveValue(/run out of money/);
  await message.press('Enter');
  await expect(
    page
      .locator('.agent-message')
      .filter({ hasText: 'Synthetic fixture research.' }),
  ).toBeVisible({ timeout: 20000 });
  await search.getByRole('link', { name: 'Open cited passage' }).click();
  await expect(page.locator('.research-document')).toContainText(
    'Existing liquidity',
  );
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page
    .getByRole('link', { name: 'Portfolio', exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Research', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('tab', { name: 'Search', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await search.getByRole('link', { name: 'Open cited passage' }).click();
  await expect(
    page.getByRole('tab', { name: 'Documents', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(search.getByLabel('Search stored evidence')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await search
    .getByRole('combobox', { name: 'Source', exact: true })
    .selectOption('sec');
  await search
    .getByRole('button', { name: 'Search documents', exact: true })
    .click();
  await expect(search).toContainText('0 matching passages');
});
