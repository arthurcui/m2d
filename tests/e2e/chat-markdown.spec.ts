import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`chat renders safe Markdown and resets clearly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    let history = [
      {
        id: 'markdown',
        kind: 'text',
        role: 'assistant',
        text: [
          '## Position summary',
          '**NVDA** is a *stock*. Review `quantity` before confirming.',
          '- Keep the selected account\n- Review the price',
          '| Holding | Shares |\n| --- | ---: |\n| NVDA | 2 |',
          '> Prices are historical.',
          '```text\nquantity: 2\n```',
          '[Source](/research?document=00000000-0000-0000-0000-000000000001#chunk-1)',
          '[Unsafe](javascript:alert(1))',
          '<script>window.chatInjected = true</script>',
          '![Remote image](https://example.invalid/tracking.png)',
        ].join('\n\n'),
      },
    ];
    let resets = 0;
    const remoteImages: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('example.invalid')) remoteImages.push(r.url());
    });
    await page.route('**/api/v1/chat/sessions/*', (r) =>
      r.fulfill({
        json: { data: { revision: 1, draft: '', history, runs: [] } },
      }),
    );
    await page.route('**/api/v1/chat/sessions/*/reset', (r) => {
      resets++;
      history = [];
      return r.fulfill({
        json: { data: { revision: 2, draft: '', history, runs: [] } },
      });
    });
    await page.goto('/portfolio');
    const log = page.getByRole('log', { name: 'Portfolio conversation' });
    await expect(
      log.getByRole('heading', { name: 'Position summary' }),
    ).toBeVisible();
    await expect(log.locator('.chat-markdown strong')).toHaveText('NVDA');
    await expect(log.locator('em')).toHaveText('stock');
    await expect(log.locator('li')).toHaveCount(2);
    await expect(log.getByRole('cell', { name: '2', exact: true })).toHaveCount(
      1,
    );
    await expect(
      log.getByRole('link', { name: 'Source', exact: true }),
    ).toHaveAttribute(
      'href',
      '/research?document=00000000-0000-0000-0000-000000000001#chunk-1',
    );
    await expect(
      log.locator('a[href^="javascript:"], script, img'),
    ).toHaveCount(0);
    expect(remoteImages).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'New conversation', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Reset conversation', exact: true }),
    ).toBeVisible();
    if (width === 390) {
      const divider = page.getByRole('separator', {
        name: 'Resize Agent panel',
      });
      await divider.focus();
      for (let i = 0; i < 4; i++) await divider.press('ArrowUp');
    }
    await page
      .locator('.agent-context:not([hidden]) .agent-reading-pane')
      .evaluate((el) => (el.scrollTop = 0));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('complementary', { name: 'Agent', exact: true })
      .screenshot({ path: `.tmp/chat-markdown-${width}.png` });
    await expect(
      page.getByLabel('Portfolio analysis mode').locator('..'),
    ).toHaveCSS('flex-direction', 'row');
    await page.getByLabel('Portfolio message').fill('Unsent draft');
    await page
      .getByRole('button', { name: 'Reset conversation', exact: true })
      .click();
    await expect(
      log.getByRole('heading', { name: 'Position summary' }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Portfolio message')).toHaveValue('');
    expect(resets).toBe(1);
  });
}
