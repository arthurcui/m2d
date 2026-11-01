import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test.beforeEach(() =>
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Isolated fixture workspace only.',
  ),
);
test('unified add panel preserves drafts, reports duplicates and opens documents without resubmitting', async ({
  page,
}) => {
  const symbol = 'UI' + randomUUID().slice(0, 8).toUpperCase();
  await page.goto('/research');
  await page.getByLabel('Research ticker').fill(symbol);
  await expect(
    page.getByRole('tab', { name: 'Overview', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Search stored evidence')).toBeHidden();
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Add research', exact: true });
  await panel.getByRole('button', { name: 'Paste text', exact: true }).click();
  const body =
    'Revenue outlook improved. Customer concentration remains a material risk. Unicode evidence: café.';
  await panel.getByLabel('Document title').fill('Research note');
  await panel.getByLabel('Research text', { exact: true }).fill(body);
  await panel.getByRole('button', { name: 'Close add research' }).click();
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
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await expect(panel.getByLabel('Research text', { exact: true })).toHaveValue(
    body,
  );
  let uploads = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/research/upload') && r.method() === 'POST')
      uploads++;
  });
  await panel.getByRole('button', { name: 'Import pasted text' }).click();
  await expect(
    panel.getByRole('button', { name: 'Import pasted text' }),
  ).toBeDisabled();
  await expect(panel).toContainText('Imported 1 new document', {
    timeout: 20000,
  });
  await panel.getByRole('button', { name: 'Import pasted text' }).click();
  await expect(panel).toContainText('Already saved · 1 document reused', {
    timeout: 20000,
  });
  const count = uploads;
  await panel
    .getByRole('button', { name: 'Open document', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Documents', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#research-document')).toContainText(body);
  expect(uploads).toBe(count);
  await expect(page.locator('.research-documents .research-card')).toHaveCount(
    1,
  );
  await page.screenshot({ path: '.tmp/research-documents-tabs.png' });
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: '.tmp/research-overview-tabs.png' });
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Close Agent', exact: true }).click();
  await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: '.tmp/research-add-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('URL browsing shows local progress, disables duplicate clicks and exposes results', async ({
  page,
}) => {
  await page.goto('/research');
  await page
    .getByLabel('Research ticker')
    .fill('URL' + randomUUID().slice(0, 8).toUpperCase());
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await page.getByRole('button', { name: 'From URL', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Add research', exact: true });
  await panel.getByLabel('Source name', { exact: true }).fill('Public reports');
  await panel
    .getByLabel('Public document or feed URL')
    .fill('https://example.com/reports');
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  await page.route('**/research/sources/discover', async (route) => {
    calls++;
    const response = await route.fetch();
    await wait;
    await route.fulfill({ response });
  });
  await panel
    .getByRole('button', { name: 'Find documents on this page' })
    .click();
  await expect(panel).toContainText('Finding document links');
  await expect(
    panel.getByRole('button', { name: 'Find documents on this page' }),
  ).toBeDisabled();
  release();
  await expect(panel).toContainText('Found 1 document');
  expect(calls).toBe(1);
  const found = panel.getByRole('region', {
    name: 'Documents from Public reports',
  });
  await found.getByRole('button', { name: 'Import document' }).click();
  await expect(found).toContainText('Imported 1 new document', {
    timeout: 20000,
  });
  await found.getByRole('button', { name: 'Check for updates' }).click();
  await expect(found).toContainText('Already saved', { timeout: 20000 });
});
test('an ambiguous upload response reuses the original request ID on retry', async ({
  page,
}) => {
  await page.goto('/research');
  await page
    .getByLabel('Research ticker')
    .fill('RETRY' + randomUUID().slice(0, 7).toUpperCase());
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Add research', exact: true });
  await panel.getByLabel('Upload a company or fund document').setInputFiles({
    name: 'retry.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Revenue guidance improved. Material customer concentration risk remains.',
    ),
  });
  const ids: string[] = [];
  await page.route('**/research/upload', async (route) => {
    ids.push(route.request().postDataJSON().idempotencyKey as string);
    const response = await route.fetch();
    if (ids.length === 1)
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Response lost. Retry the upload.' } },
      });
    else await route.fulfill({ response });
  });
  await panel
    .getByRole('button', { name: 'Upload document', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('Response lost');
  await panel
    .getByRole('button', { name: 'Upload document', exact: true })
    .click();
  await expect(panel).toContainText('Imported 1 new document', {
    timeout: 20000,
  });
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(page.locator('.research-documents .research-card')).toHaveCount(
    1,
  );
});
