import { test, expect } from '@playwright/test';
test('branded workspace, persisted operations, and honest navigation placeholders', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('M²D · Move · Motive · Decision');
  await expect(
    page.getByRole('link', { name: 'Dashboard', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'online', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const response = await request.get('/api/v1/health/ready');
  expect(response.ok()).toBe(true);
  const status = await (await request.get('/api/v1/system/status')).json();
  expect(status.data.ai.available).toBe(false);
  expect(status.data.worker.lastDemoJob).toBeTruthy();
  await expect(
    page.getByText('Refreshes in 9 seconds', { exact: true }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByText('Refreshes in 1 second', { exact: true }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByText('Refreshes in 10 seconds', { exact: true }),
  ).toBeVisible({ timeout: 7000 });
  await page.getByRole('link', { name: 'Portfolio', exact: false }).click();
  await expect(
    page.getByRole('link', { name: 'Portfolio', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { name: 'Not available in M0' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Chat', exact: false }).click();
  await expect(page.getByText(/Quick \/ Standard \/ Extensive/)).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
test('API outage is visible and the page fits a narrow screen', async ({
  page,
}) => {
  await page.route('**/api/v1/system/status', (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByText('Status refresh failed.', { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
