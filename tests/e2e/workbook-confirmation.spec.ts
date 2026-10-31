import { test, expect } from '@playwright/test';
test('an already-applied workbook offers a new replacement preview with explicit acknowledgement', async ({
  page,
}) => {
  const old = {
    id: 'old',
    kind: 'BASELINE',
    status: 'CONFIRMED',
    expectedRevision: 0,
    confirmedRevision: 1,
    importId: 'upload',
    effectiveAt: '2026-10-01T12:00:00Z',
    expiresAt: '2026-10-01T12:15:00Z',
    changes: [],
    warnings: [],
    realized: [],
  };
  const fresh = {
    ...old,
    id: 'fresh',
    status: 'PENDING',
    expectedRevision: 2,
    confirmedRevision: null,
    importId: null,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  let confirmed = 0;
  await page.route('**/api/v1/portfolio/overview', (r) =>
    r.fulfill({
      json: {
        data: {
          revision: 2,
          effectiveAt: null,
          baselineId: 'baseline',
          state: { accounts: [], positions: [], cash: [] },
          warnings: [],
        },
      },
    }),
  );
  await page.route('**/api/v1/portfolio/history', (r) =>
    r.fulfill({
      json: {
        data: [
          {
            id: 'history',
            recordId: 'baseline',
            revision: 1,
            kind: 'BASELINE',
            note: 'Workbook',
            effectiveAt: old.effectiveAt,
            availableAt: old.effectiveAt,
            accountKey: null,
            changes: [],
            realized: [],
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/portfolio/imports', (r) =>
    r.fulfill({ json: { data: { id: 'upload', preview: old, errors: [] } } }),
  );
  await page.route(
    '**/api/v1/portfolio/baselines/baseline/restore-preview',
    (r) => r.fulfill({ json: { data: fresh } }),
  );
  await page.route('**/api/v1/portfolio/changes/fresh/confirm', (r) => {
    confirmed++;
    return r.fulfill({ json: { data: { revision: 3, duplicate: false } } });
  });
  await page.goto('/portfolio');
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'repeat.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('fixture'),
  });
  await page
    .getByRole('button', { name: 'Preview workbook', exact: true })
    .click();
  const preview = page.getByRole('region', {
    name: 'Confirmation preview',
    exact: true,
  });
  await expect(preview).toContainText('This workbook was already applied.');
  await expect(
    preview.getByRole('button', { name: 'Already applied', exact: true }),
  ).toBeDisabled();
  await preview
    .getByRole('button', { name: 'Review this workbook again', exact: true })
    .click();
  await expect(preview).toContainText('To enable confirmation');
  const confirm = preview.getByRole('button', {
    name: 'Confirm changes',
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await preview.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();
  expect(confirmed).toBe(0);
  await confirm.click();
  await expect.poll(() => confirmed).toBe(1);
});
