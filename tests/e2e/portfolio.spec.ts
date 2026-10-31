import { test, expect } from '@playwright/test';
import { arbitraryWorkbook } from '../flexible-fixture.js';
import { expiryWorkbook } from '../interpretation-fixture.js';
import {
  workbook,
  sevenAccountFixture,
} from '../../packages/ingestion/src/index.js';
// This suite is deliberately opt-in: it writes only to a disposable E2E workspace.
test.beforeAll(() => {
  if (process.env.E2E_ALLOW_PORTFOLIO_WRITES !== '1')
    throw new Error(
      'Use a disposable Compose project and set E2E_ALLOW_PORTFOLIO_WRITES=1. Portfolio E2E was not run.',
    );
});

test('interprets existing multi-tab Excel layouts before creating a confirmation preview', async ({
  page,
  request,
}) => {
  await page.goto('/portfolio');
  await expect(page.getByLabel(/Workbook effective time/)).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Download template' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Record a change' }),
  ).toHaveCount(0);
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'existing-portfolio.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook(),
  });
  const uploadSection = page.getByRole('region', {
    name: 'Replace from Excel',
  });
  await page.route(
    '**/api/v1/portfolio/imports',
    (route) =>
      route.fulfill({
        status: 500,
        json: { error: { message: 'Upload temporarily unavailable' } },
      }),
    { times: 1 },
  );
  await uploadSection.getByRole('button', { name: 'Preview workbook' }).click();
  await expect(uploadSection.getByRole('alert')).toContainText(
    'Upload temporarily unavailable',
  );
  await page.route(
    '**/api/v1/portfolio/imports/*/parse',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { message: 'Parsing temporarily unavailable' } },
      }),
    { times: 1 },
  );
  await uploadSection.getByRole('button', { name: 'Preview workbook' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Agent' }).getByRole('alert'),
  ).toContainText('Parsing temporarily unavailable');
  await page
    .getByRole('region', { name: 'Workbook clarification' })
    .getByRole('button', { name: 'Send to Agent' })
    .click();
  await page
    .getByRole('button', {
      name: 'Create new account: Retirement',
      exact: true,
    })
    .click();
  await page.getByRole('link', { name: 'Opportunities', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Agent' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Create new account: Savings',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create new account: Savings', exact: true })
    .click();
  const before = (
    await (await request.get('/api/v1/portfolio/overview')).json()
  ).data.revision;
  await expect(
    page.getByRole('region', { name: 'Workbook interpretation' }),
  ).toHaveCount(0);
  const preview = page.getByRole('region', { name: 'Confirmation preview' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('12345.67');
  await expect(preview).toContainText('-123.45');
  expect(
    (await (await request.get('/api/v1/portfolio/overview')).json()).data
      .revision,
  ).toBe(before);
  await preview.getByRole('checkbox').check();
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Confirm changes' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(preview.getByRole('checkbox')).toBeChecked();
  await page.route(
    '**/api/v1/portfolio/changes/*/confirm',
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: { message: 'Confirmation unavailable' } },
      }),
    { times: 1 },
  );
  await preview.getByRole('button', { name: 'Confirm changes' }).click();
  await expect(preview.getByRole('alert')).toContainText(
    'Confirmation unavailable',
  );
  // Dismiss, so this read/preview test cannot alter the starting state of the canonical acceptance case.
  await preview.getByRole('button', { name: 'Dismiss preview' }).click();
  await expect(preview).toHaveCount(0);
});
test('Excel full replacement requires acknowledgement and preserves history without manual entry fields', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  await page.goto('/portfolio');
  await expect(
    page.getByRole('heading', { name: 'Accounts & holdings' }),
  ).toBeVisible();
  const fixture = sevenAccountFixture();
  const importForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Preview workbook' }) });
  await importForm.getByLabel(/Excel workbook/).setInputFiles({
    name: 'portfolio.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook(fixture),
  });
  await importForm.getByRole('button', { name: 'Preview workbook' }).click();
  const preview = page.getByRole('region', { name: 'Confirmation preview' });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('button', { name: 'Confirm changes' }),
  ).toBeDisabled();
  const before = await (await request.get('/api/v1/portfolio/overview')).json();
  expect(before.data.state.accounts).toHaveLength(0);
  await preview.getByRole('checkbox').check();
  await preview.getByRole('button', { name: 'Confirm changes' }).click();
  await expect(page.getByRole('status')).toContainText('Confirmed revision 1');
  fixture.positions.pop();
  await importForm.getByLabel(/Excel workbook/).setInputFiles({
    name: 'replacement.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook(fixture),
  });
  await importForm.getByRole('button', { name: 'Preview workbook' }).click();
  await expect(preview).toContainText('0 @ 0');
  const held = (await (await request.get('/api/v1/portfolio/overview')).json())
    .data.state.positions as { accountKey: string; quantity: string }[];
  expect(held.find((p) => p.accountKey === 'DEMO7')?.quantity).toBe('100');
  await preview.getByRole('checkbox').check();
  await preview.getByRole('button', { name: 'Confirm changes' }).click();
  await expect(page.getByRole('status')).toContainText('Confirmed revision 2');
  await expect(
    page.locator('summary').filter({ hasText: 'Revision 1' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('m1-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('m1-mobile.png'),
    fullPage: true,
  });
  const blocked = await request.post('/api/v1/portfolio/changes/preview', {
    headers: { origin: 'https://attacker.invalid' },
    data: {},
  });
  expect(blocked.status()).toBe(403);
});
test('Agent docks responsively and remembers its closed state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/portfolio');
  const agent = page.getByRole('complementary', { name: 'Agent' });
  await expect(agent).toBeVisible();
  const panel = await agent.boundingBox(),
    records = await page
      .getByRole('heading', { name: 'Accounts & holdings' })
      .boundingBox();
  expect(panel!.x).toBeGreaterThan(records!.x);
  await agent.getByRole('button', { name: 'Close Agent' }).click();
  await expect(agent).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Agent' }).click();
  await expect(agent).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await agent.boundingBox();
  expect(Math.round(mobile!.y + mobile!.height)).toBe(844);
  expect(mobile!.width).toBeLessThanOrEqual(390);
  await agent.getByRole('button', { name: 'Close Agent' }).click();
  await page.getByRole('button', { name: 'Open Agent' }).click();
  await expect(agent).toBeVisible();
});
test('Agent retains clarification context across replies and a lost request', async ({
  page,
}) => {
  await page.goto('/portfolio');
  const sent: {
    clarification: string;
    idempotencyKey: string;
    dialogue?: { message: string; question: string };
  }[] = [];
  await page.route('**/api/v1/portfolio/imports/*/parse', async (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 2) {
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Connection interrupted' } },
      });
      return;
    }
    await route.fulfill({
      json: {
        data: {
          preview: null,
          sources: [],
          errors: [],
          exclusions: [],
          ai: {
            status: 'needs_clarification',
            questions: [
              sent.length === 1
                ? 'Which broker holds this account?'
                : 'What is the account name?',
            ],
            message: 'Please clarify',
            provider: 'fixture',
            model: 'fixture-v1',
            asOf: new Date().toISOString(),
          },
        },
      },
    });
  });
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'agent-context.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook('307'),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  const agent = page.getByRole('complementary', { name: 'Agent' }),
    composer = agent.getByLabel('Message Agent');
  await expect(composer).toBeVisible();
  await composer.fill('Broker is Example Broker');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(composer).toBeHidden();
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(composer).toHaveValue('Broker is Example Broker');
  await agent.getByRole('button', { name: 'Send to Agent' }).click();
  await expect(agent.getByRole('alert')).toHaveText('Connection interrupted');
  await agent.getByRole('button', { name: 'Send to Agent' }).click();
  await expect(composer).toBeEnabled();
  expect(sent[2]?.clarification).toBe(sent[1]?.clarification);
  expect(sent[2]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
  expect(sent[2]?.dialogue).toEqual(sent[1]?.dialogue);
  await composer.fill('Account name is Retirement');
  await agent.getByRole('button', { name: 'Send to Agent' }).click();
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3]?.clarification).toBe('Broker is Example Broker');
  expect(sent[3]?.dialogue?.message).toBe('Account name is Retirement');
  expect(sent[3]?.dialogue?.question).toBe('What is the account name?');
  await agent.getByRole('button', { name: 'Close Agent' }).click();
  await page.getByRole('button', { name: 'Open Agent' }).click();
  await expect(agent.getByRole('log')).toContainText(
    'Broker is Example Broker',
  );
  await agent.getByRole('button', { name: 'Cancel import' }).click();
});
test('Agent explains follow-up questions without advancing or adding them to workbook facts', async ({
  page,
}) => {
  const sent: {
    clarification: string;
    dialogue?: { message: string; question: string; explain: boolean };
  }[] = [];
  const question = 'Tab "Retirement": what is the account type?';
  await page.route('**/api/v1/portfolio/imports/*/parse', async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    const explaining = !!body.dialogue && body.dialogue.message !== 'RRSP';
    await route.fulfill({
      json: {
        data: {
          preview: null,
          sources: [],
          errors: [],
          exclusions: [],
          acceptedClarification: '',
          ai: {
            status: 'needs_clarification',
            provider: 'fixture',
            model: 'fixture-v1',
            questions:
              body.dialogue?.message === 'RRSP'
                ? ['What is the cash balance?']
                : [question, 'Bulk question that must not be shown'],
            ...(explaining
              ? {
                  intent: 'explain',
                  reply:
                    'Account type labels the account, not its holdings. RRSP is one of the supported labels.',
                }
              : {}),
          },
        },
      },
    });
  });
  await page.goto('/portfolio');
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'follow-up.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook('519'),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  const agent = page.getByRole('complementary', { name: 'Agent' });
  const composer = agent.getByLabel('Message Agent');
  await expect(agent.getByRole('log')).toContainText(question);
  await expect(agent).not.toContainText('Bulk question');
  await composer.fill('whats AccountType for?');
  await composer.press('Shift+Enter');
  await expect(composer).toHaveValue('whats AccountType for?\n');
  expect(sent).toHaveLength(1);
  await composer.press('Enter');
  await expect(agent.getByLabel('Pending question')).toContainText(question);
  await expect(agent.getByRole('log')).toContainText('not its holdings');
  expect(sent[1]?.clarification).toBe('');
  expect(sent[1]?.dialogue?.question).toBe(question);
  await agent.getByRole('button', { name: 'Explain this question' }).click();
  await expect(composer).toBeEnabled();
  expect(sent[2]?.dialogue?.explain).toBe(true);
  await composer.fill('RRSP');
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await composer.dispatchEvent('keydown', { key: 'Enter', repeat: true });
  expect(sent).toHaveLength(3);
  await composer.press('Enter');
  await expect(agent.getByRole('log')).toContainText(
    'What is the cash balance?',
  );
  expect(sent[3]?.clarification).toBe('');
  expect(sent[3]?.dialogue?.message).toBe('RRSP');
  expect(sent[3]?.dialogue?.question).toBe(question);
  await expect(
    agent.getByRole('button', { name: 'Confirm changes' }),
  ).toHaveCount(0);
  await agent.getByRole('button', { name: 'Cancel import' }).click();
});

test('explicit interpretation retry preserves already accepted row answers', async ({
  page,
}) => {
  const facts = JSON.stringify({
    sheet: 'Retirement',
    row: 4,
    field: 'AssetType',
    answer: 'CASH',
  });
  const requests: {
    clarification: string;
    retry: boolean;
    idempotencyKey: string;
  }[] = [];
  await page.route('**/api/v1/portfolio/imports/*/parse', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        data: {
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          acceptedClarification: facts,
          ai: {
            status: 'needs_review',
            reply:
              'I could not apply an answer you already supplied. You do not need to repeat it.',
            questions: ['Tab "Retirement", row 4: what is the asset class?'],
            provider: 'fixture',
            model: 'fixture-v1',
          },
        },
      },
    });
  });
  await page.goto('/portfolio');
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'retry-answer.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook('621'),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  const retry = page.getByRole('button', { name: 'Retry interpretation' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.clarification).toBe(facts);
  expect(requests[1]?.retry).toBe(true);
  expect(requests[1]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
  await page.getByRole('button', { name: 'Cancel import' }).click();
});

test('selected workbook survives navigation before upload and Agent is available everywhere', async ({
  page,
}) => {
  await page.goto('/portfolio');
  const input = page.getByLabel(/Excel workbook/);
  await input.setInputFiles({
    name: 'unfinished-upload.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook('777'),
  });
  for (const section of ['Research', 'Opportunities', 'Dashboard']) {
    await page.getByRole('link', { name: section, exact: true }).click();
    await expect(
      page.getByRole('complementary', { name: 'Agent' }),
    ).toBeVisible();
  }
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  expect(
    await input.evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
  ).toBe('unfinished-upload.xlsx');
});

test('Agent restores independent function conversations and drafts', async ({
  page,
}) => {
  await page.goto('/research');
  const agent = page.getByRole('complementary', { name: 'Agent' });
  await expect(
    agent.getByRole('heading', { name: 'Agent · Research', exact: true }),
  ).toBeVisible();
  await agent.getByLabel('Research draft').fill('Review company filings');
  await agent.getByLabel('Research draft').press('Enter');
  await expect(agent.getByLabel('Research draft')).toHaveValue('');
  await agent.getByLabel('Research draft').press('Enter');
  await expect(
    agent.getByRole('log').getByText('Review company filings', { exact: true }),
  ).toHaveCount(1);
  await agent.getByLabel('Research draft').fill('Unsent research question');
  await page.getByRole('link', { name: 'Opportunities', exact: true }).click();
  await expect(
    agent.getByRole('heading', { name: 'Agent · Opportunities', exact: true }),
  ).toBeVisible();
  await expect(agent.getByRole('log')).not.toContainText(
    'Review company filings',
  );
  await agent.getByLabel('Opportunities draft').fill('Track an opportunity');
  await agent.getByRole('button', { name: 'Save note' }).click();
  await agent
    .getByLabel('Opportunities draft')
    .fill('Unsent opportunity question');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(agent.getByRole('log')).toContainText('Review company filings');
  await expect(agent.getByRole('log')).not.toContainText(
    'Track an opportunity',
  );
  await expect(agent.getByLabel('Research draft')).toHaveValue(
    'Unsent research question',
  );
  await agent.getByRole('button', { name: 'Close Agent' }).click();
  await page.getByRole('button', { name: 'Open Agent' }).click();
  await expect(agent.getByLabel('Research draft')).toHaveValue(
    'Unsent research question',
  );
  await page.getByRole('link', { name: 'Opportunities', exact: true }).click();
  await expect(agent.getByLabel('Opportunities draft')).toHaveValue(
    'Unsent opportunity question',
  );
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(
    agent.getByRole('heading', { name: 'Agent · Portfolio', exact: true }),
  ).toBeVisible();
  await expect(agent.getByRole('log')).not.toContainText(
    'Review company filings',
  );
});

test('background portfolio replies stay in Portfolio after switching context', async ({
  page,
}) => {
  await page.goto('/portfolio');
  let finish!: () => void;
  let started = false;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/v1/portfolio/imports/*/parse', async (route) => {
    started = true;
    await waiting;
    await route.fulfill({
      json: {
        data: {
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          ai: {
            status: 'needs_clarification',
            questions: ['Portfolio-only background question'],
            provider: 'fixture',
            model: 'fixture-v1',
          },
        },
      },
    });
  });
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'background-context.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await arbitraryWorkbook('913'),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  await expect.poll(() => started).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Processing your workbook…' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Agent' });
  await agent.getByLabel('Research draft').fill('Keep this research draft');
  const response = page.waitForResponse('**/api/v1/portfolio/imports/*/parse');
  finish();
  await response;
  await expect(agent.getByRole('log')).not.toContainText(
    'Portfolio-only background question',
  );
  await expect(agent.getByLabel('Research draft')).toHaveValue(
    'Keep this research draft',
  );
  await expect(
    agent.getByRole('heading', { name: 'Agent · Research', exact: true }),
  ).toBeVisible();
  await agent.getByRole('link', { name: 'Return to Portfolio' }).click();
  await expect(agent.getByRole('log')).toContainText(
    'Portfolio-only background question',
  );
  await expect(agent.getByLabel('Message Agent')).toBeVisible();
  await agent.getByRole('button', { name: 'Cancel import' }).click();
});

test('shows the current-year expiry assumption before confirmation', async ({
  page,
  request,
}) => {
  const before = (
    await (await request.get('/api/v1/portfolio/overview')).json()
  ).data.revision;
  await page.goto('/portfolio');
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'expiry-default.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await expiryWorkbook(),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  await page
    .getByRole('button', { name: 'Create new account: Expiry RRSP' })
    .click();
  const preview = page.getByRole('region', { name: 'Confirmation preview' });
  await expect(preview).toBeVisible();
  const year = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
  }).format(new Date());
  await expect(preview).toContainText(
    `no option expiry year was supplied; used current year ${year}`,
  );
  await expect(preview).toContainText(`${year}-10-30`);
  expect(
    (await (await request.get('/api/v1/portfolio/overview')).json()).data
      .revision,
  ).toBe(before);
  await preview.getByRole('button', { name: 'Dismiss preview' }).click();
});

test('accepts seven account choices and suppresses repeated clicks while processing the last tab', async ({
  page,
}) => {
  const { sevenAccountTabs } = await import('../flexible-fixture.js');
  let requests = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/portfolio/imports/*/parse', async (route) => {
    requests++;
    const input = route.request().postDataJSON() as {
      accountDecisions: { sheet: string }[];
    };
    const names = Array.from(
      { length: 7 },
      (_, i) => `Choice Account ${i + 1}`,
    ).filter((sheet) => !input.accountDecisions.some((d) => d.sheet === sheet));
    if (!names.length) await pending;
    await route.fulfill({
      json: {
        data: {
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          ai: {
            status: names.length ? 'needs_clarification' : 'needs_review',
            provider: 'fixture',
            model: 'fixture-v1',
            questions: [],
            accountQuestions: names.map((sheet) => ({ sheet, accounts: [] })),
            ...(!names.length
              ? {
                  reply:
                    'All seven account choices are retained; the mapping needs review.',
                }
              : {}),
          },
        },
      },
    });
  });
  await page.goto('/portfolio');
  await page.getByLabel(/Excel workbook/).setInputFiles({
    name: 'seven-choices.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await sevenAccountTabs(),
  });
  await page.getByRole('button', { name: 'Preview workbook' }).click();
  for (let i = 1; i < 7; i++)
    await page
      .getByRole('button', {
        name: `Create new account: Choice Account ${i}`,
        exact: true,
      })
      .click();
  const last = page.getByRole('button', {
    name: 'Create new account: Choice Account 7',
    exact: true,
  });
  await last.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => requests).toBe(8);
  await expect(last).toBeDisabled();
  await expect(
    page
      .getByRole('log')
      .getByText('Create a new account for "Choice Account 7".', {
        exact: true,
      }),
  ).toHaveCount(1);
  release();
  await expect(
    page.getByRole('button', { name: 'Retry interpretation' }),
  ).toBeVisible();
  await expect(page.getByRole('log')).toContainText(
    'All seven account choices are retained',
  );
  expect(requests).toBe(8);
});
