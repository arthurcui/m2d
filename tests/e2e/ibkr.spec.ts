import { test, expect } from '@playwright/test';
test('IBKR connection shows read-only scope and keeps the selected provider explicit', async ({
  page,
}) => {
  await page.route('**/api/v1/market/ibkr/status', (route) =>
    route.fulfill({
      json: {
        data: {
          connected: true,
          pending: false,
          active: false,
          available: true,
          scope: 'mcp.read',
          expiresAt: null,
        },
      },
    }),
  );
  await page.goto('/market');
  const panel = page.getByRole('region', { name: 'IBKR connection' });
  await expect(panel).toContainText('Connected');
  await expect(panel).toContainText(
    'Choose IBKR in the Price provider selector',
  );
  await expect(panel).toContainText('recorded portfolio remains self-reported');
  await expect(
    panel.getByRole('button', { name: 'Reconnect IBKR' }),
  ).toBeEnabled();
  await page.route('**/api/v1/market/ibkr/disconnect', (route) =>
    route.fulfill({ json: { data: { connected: false } } }),
  );
  await page.route('**/api/v1/market/ibkr/status', (route) =>
    route.fulfill({
      json: {
        data: {
          connected: false,
          pending: false,
          active: false,
          available: true,
          scope: 'mcp.read',
          expiresAt: null,
        },
      },
    }),
  );
  await panel.getByRole('button', { name: 'Disconnect IBKR' }).click();
  await expect(panel.getByRole('status')).toContainText(
    'Local IBKR authorization removed',
  );
  await expect(
    panel.getByRole('button', { name: 'Connect IBKR' }),
  ).toBeEnabled();
});
test('IBKR connection errors stay beside the action and callbacks reject an unbound browser', async ({
  page,
}) => {
  await page.route('**/api/v1/market/ibkr/status', (route) =>
    route.fulfill({
      json: {
        data: {
          connected: false,
          pending: false,
          active: false,
          available: true,
          scope: 'mcp.read',
          expiresAt: null,
        },
      },
    }),
  );
  await page.route('**/api/ibkr/connect', (route) =>
    route.fulfill({
      status: 502,
      json: { error: { message: 'IBKR connection failed; retry later.' } },
    }),
  );
  await page.goto('/market');
  const panel = page.getByRole('region', { name: 'IBKR connection' });
  await panel.getByRole('button', { name: 'Connect IBKR' }).click();
  await expect(panel.getByRole('alert')).toContainText('retry later');
  await page.goto(
    '/api/ibkr/callback?state=invalid&code=never-log-this&iss=https%3A%2F%2Fapi.ibkr.com',
  );
  await expect(panel.getByRole('alert')).toContainText('cancelled, expired');
  await expect(page).toHaveURL(/\/market$/);
  const bypass = await page.request.post('/api/v1/market/ibkr/callback', {
    data: { state: 'bad', code: 'bad' },
  });
  expect(bypass.status()).toBe(404);
});
