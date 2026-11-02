import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test.beforeEach(() =>
  test.skip(
    process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1',
    'Disposable fixture workspace only.',
  ),
);

test('company typing is separate from context; removals persist without deleting documents', async ({
  page,
  request,
}) => {
  const symbol = 'PICK' + randomUUID().slice(0, 8).toUpperCase();
  await page.goto('/research');
  const input = page.getByLabel('Research ticker');
  await input.fill(symbol);
  await expect(
    page.getByRole('button', { name: 'Add research', exact: true }),
  ).toBeDisabled();
  await input.press('Enter');
  await expect(page.locator('.selected-company')).toContainText(symbol);
  await input.fill('NOTSELECTED');
  await expect(page.locator('.selected-company')).toContainText(symbol);
  await input.press('Escape');
  const reports = page.getByRole('region', { name: 'Company reports' });
  await reports.getByRole('button', { name: 'Load demo reports' }).click();
  await expect(reports).toContainText('Imported 2 new documents', {
    timeout: 20000,
  });
  await expect(reports.getByText(/Last successful check:/)).toContainText(
    /\d{4}/,
  );
  await reports.getByRole('button', { name: 'Load demo reports' }).click();
  await expect(reports).toContainText('Already saved · 2 documents reused', {
    timeout: 20000,
  });
  const docs = (
    await (await request.get(`/api/v1/research/companies/${symbol}`)).json()
  ).data.documents;
  await input.fill(symbol);
  await page
    .getByRole('button', {
      name: `Remove ${symbol} from suggestions`,
      exact: true,
    })
    .click();
  await expect(page.locator('.selected-company')).toHaveCount(0);
  await page.reload();
  await input.fill(symbol);
  await expect(
    page.getByRole('button', { name: `Select ${symbol}`, exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await request.get(`/api/v1/research/companies/${symbol}`)).json())
      .data.documents,
  ).toEqual(docs);
  await input.press('Enter');
  await expect(page.locator('.selected-company')).toContainText(symbol);
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await page.getByLabel('Filter documents').fill('10-Q');
  await page.getByRole('button', { name: 'Add research', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Research' }).click();
  await expect(
    page.getByRole('tab', { name: 'Documents', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Filter documents')).toHaveValue('10-Q');
});

test('next-send settings can change during a reply and do not reset conversation or active limits', async ({
  page,
  request,
}) => {
  await page.goto('/chat');
  const chat = page.getByRole('region', { name: 'General chat', exact: true });
  await chat.getByRole('button', { name: 'Reset conversation' }).click();
  await chat.getByLabel('General reply language').selectOption('en');
  await expect(chat.getByLabel('General reply language')).toBeEnabled();
  await chat.getByLabel('General analysis mode').selectOption('quick');
  await expect(chat.getByLabel('General analysis mode')).toBeEnabled();
  let held = true;
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/chat/sessions/general', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (held && json.data.runs[0]) json.data.runs[0].status = 'running';
    await route.fulfill({ response, json });
  });
  await page.route('**/api/v1/chat/runs/*/events*', async (route) => {
    await wait;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: terminal\ndata: {}\n\n',
    });
  });
  const message = chat.getByLabel('General message');
  await message.fill('hello');
  await message.press('Enter');
  await expect(
    chat.getByText(/Usage for this reply · quick · running/),
  ).toBeVisible();
  await chat.getByLabel('General analysis mode').selectOption('extensive');
  await expect(chat.getByLabel('General analysis mode')).toBeEnabled();
  await chat.getByLabel('General reply language').selectOption('zh-CN');
  await expect(chat.getByLabel('General reply language')).toBeEnabled();
  const first = (
    await (await request.get('/api/v1/chat/sessions/general')).json()
  ).data.runs[0];
  expect(first.analysisMode).toBe('quick');
  expect(first.outputLanguage).toBe('en');
  held = false;
  release();
  await expect(message).toBeEnabled();
  await page.unroute('**/api/v1/chat/runs/*/events*');
  await page.unroute('**/api/v1/chat/sessions/general');
  await message.fill('Continue the previous question');
  await message.press('Enter');
  await expect(
    chat.getByText(/Usage for this reply · extensive · completed/),
  ).toBeVisible();
  const session = (
    await (await request.get('/api/v1/chat/sessions/general')).json()
  ).data;
  expect(session.runs[0].outputLanguage).toBe('zh-CN');
  expect(session.runs[0].effectiveLimits.modelCalls).toBeGreaterThan(
    first.effectiveLimits.modelCalls,
  );
  expect(
    session.history.filter((i: { role?: string }) => i.role === 'user'),
  ).toHaveLength(2);
  await page.reload();
  await expect(chat.getByLabel('General reply language')).toHaveValue('zh-CN');
  await expect(chat.getByRole('log')).toContainText(
    'Continue the previous question',
  );
  await chat.getByLabel('General reply language').selectOption('en');
  await expect(chat.getByLabel('General reply language')).toBeEnabled();
});
