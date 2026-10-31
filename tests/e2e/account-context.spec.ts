import { test, expect } from '@playwright/test';
test('account context scopes messages and new messages scroll into view', async ({
  page,
}) => {
  let history = Array.from({ length: 35 }, (_, i) => ({
    id: String(i),
    kind: 'text',
    role: 'assistant',
    text: `Previous answer ${i}. ${'Saved conversation detail. '.repeat(12)}`,
  }));
  let sent: Record<string, unknown> | undefined;
  await page.route('**/api/v1/portfolio/overview', (r) =>
    r.fulfill({
      json: {
        data: {
          revision: 1,
          effectiveAt: null,
          baselineId: null,
          warnings: [],
          state: {
            accounts: [
              {
                accountKey: 'tfsa',
                displayName: 'Questrade TFSA',
                institution: 'Questrade',
                accountType: 'TFSA',
                baseCurrency: 'USD',
                active: true,
                notes: '',
              },
            ],
            positions: [],
            cash: [],
          },
        },
      },
    }),
  );
  await page.route('**/api/v1/portfolio/history', (r) =>
    r.fulfill({ json: { data: [] } }),
  );
  await page.route('**/api/v1/chat/sessions/*', (r) =>
    r.fulfill({
      json: { data: { revision: 1, draft: '', history, runs: [] } },
    }),
  );
  await page.route('**/api/v1/chat/sessions/*/runs', (r) => {
    sent = r.request().postDataJSON() as Record<string, unknown>;
    history = [
      ...history,
      {
        id: 'new-user',
        kind: 'text',
        role: 'user',
        text: String(sent.message),
      },
      {
        id: 'new-answer',
        kind: 'text',
        role: 'assistant',
        text: 'Newest reply: 5 TSLA shares in Questrade TFSA.',
      },
    ];
    return r.fulfill({ json: { data: { id: 'mock', status: 'completed' } } });
  });
  await page.route('**/api/v1/chat/sessions/*/reset', (r) => {
    history = [];
    return r.fulfill({
      json: { data: { revision: 2, draft: '', history, runs: [] } },
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/portfolio');
  await page
    .getByRole('button', { name: 'Use Questrade TFSA as Agent context' })
    .click();
  await expect(page.locator('.holding-context-chip')).toContainText(
    'Selected account',
  );
  await page.reload();
  await expect(page.locator('.holding-context-chip')).toContainText(
    'Selected account',
  );
  const pane = page.locator('.agent-context:not([hidden]) .agent-reading-pane');
  await expect
    .poll(() =>
      pane.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
    )
    .toBeLessThan(50);
  await pane.evaluate((e) => {
    e.scrollTop = 0;
  });
  await expect(
    page.getByRole('button', { name: 'Latest message' }),
  ).toBeVisible();
  await page.getByLabel('Portfolio message').fill('how many tsla?');
  await page.getByLabel('Portfolio message').press('Enter');
  await expect(
    page.getByText('Newest reply: 5 TSLA shares in Questrade TFSA.'),
  ).toBeInViewport();
  expect(sent).toMatchObject({ holdingContext: { accountKey: 'tfsa' } });
  expect(
    (sent?.holdingContext as Record<string, unknown>).instrumentKey,
  ).toBeUndefined();
  await page
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await expect(
    page.getByText('Newest reply: 5 TSLA shares in Questrade TFSA.'),
  ).toHaveCount(0);
  await expect.poll(() => pane.evaluate((e) => e.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Clear selected account' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
