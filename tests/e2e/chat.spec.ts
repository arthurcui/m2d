import { test, expect } from '@playwright/test';
test('Advisor persists a streamed conversation, mode preference and draft across reloads', async ({
  page,
}) => {
  if (process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1')
    throw new Error('Run only against a disposable fixture workspace.');
  await page.goto('/chat');
  const chat = page.getByRole('region', { name: 'General chat', exact: true });
  await expect(chat.getByLabel('General message')).toBeEnabled();
  await chat
    .getByRole('button', { name: 'Reset conversation', exact: true })
    .click();
  await chat.getByLabel('General analysis mode').selectOption('quick');
  await expect(chat.getByLabel('General analysis mode')).toBeEnabled();
  await chat
    .getByLabel('General message')
    .fill('Summarize my recorded portfolio');
  await chat.getByLabel('General message').press('Enter');
  await expect(chat.getByRole('log')).toContainText('offline fixture mode');
  await expect(chat.getByText(/quick · completed/)).toBeVisible();
  await chat.getByLabel('General message').fill('Unsent follow-up');
  await page.reload();
  await expect(chat.getByLabel('General message')).toHaveValue(
    'Unsent follow-up',
  );
  await expect(chat.getByRole('log')).toContainText(
    'Summarize my recorded portfolio',
  );
  await expect(chat.getByLabel('General analysis mode')).toHaveValue('quick');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Advisor · Research' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Chat', exact: false }).click();
  await expect(chat.getByLabel('General message')).toHaveValue(
    'Unsent follow-up',
  );
  await chat.getByLabel('General analysis mode').selectOption('standard');
  await expect(chat.getByLabel('General analysis mode')).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
