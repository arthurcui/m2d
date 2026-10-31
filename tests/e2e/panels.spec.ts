import { test, expect } from '@playwright/test';
test('resize panels, automatically save mode, and send consecutive messages', async ({
  page,
}) => {
  let mode = 'standard';
  let sends = 0;
  let history: { id: string; kind: string; role: string; text: string }[] = [];
  await page.route('**/api/v1/settings/analysis', (route) => {
    if (route.request().method() === 'PATCH')
      mode = route.request().postDataJSON().defaultAnalysisMode as string;
    return route.fulfill({
      json: { data: { revision: 1, effectiveDefault: mode } },
    });
  });
  await page.route('**/api/v1/chat/sessions/*', (route) =>
    route.fulfill({
      json: { data: { revision: 1, draft: '', history, runs: [] } },
    }),
  );
  await page.route('**/api/v1/chat/sessions/*/runs', (route) => {
    sends++;
    history = [
      ...history,
      {
        id: String(sends),
        kind: 'text',
        role: 'user',
        text: route.request().postDataJSON().message as string,
      },
    ];
    return route.fulfill({
      json: { data: { id: String(sends), status: 'completed' } },
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/portfolio');
  const divider = page.getByRole('separator', { name: 'Resize Agent panel' });
  await expect(divider).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Agent', exact: true });
  const before = (await panel.boundingBox())!.width;
  await divider.focus();
  await divider.press('ArrowLeft');
  expect((await panel.boundingBox())!.width).toBeGreaterThan(before);
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + 7, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x - 50, box.y + 30);
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(before);
  await expect(
    page.getByRole('button', { name: 'Save as default' }),
  ).toHaveCount(0);
  await page.getByLabel('Portfolio analysis mode').selectOption('quick');
  await expect(page.getByRole('status')).toHaveText('Default saved: quick.');
  expect(mode).toBe('quick');
  const message = page.getByLabel('Portfolio message');
  await message.fill('sold 1 AAPL at 200 fee 0');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  await message.fill('sold 2 AAPL at 210 fee 0');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  expect(sends).toBe(2);
  await page.reload();
  await expect(page.getByLabel('Portfolio analysis mode')).toHaveValue('quick');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  const height = (await panel.boundingBox())!.height;
  await divider.focus();
  await divider.press('ArrowUp');
  expect((await panel.boundingBox())!.height).toBeGreaterThan(height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
