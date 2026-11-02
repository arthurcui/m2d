import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import { readConfig } from '../packages/config/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { instrumentSchema } from '../packages/portfolio/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL must name a disposable PostgreSQL database.',
  );
const admin = createDatabase(url),
  name = `m2d_chat_test_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const database = createDatabase(target.toString()),
  r = database.portfolio,
  chat = database.chat;
const app = buildApp(
  database.repository,
  readConfig({ DATABASE_URL: target.toString() }),
  false,
  r,
  { chat },
);
const stock = instrumentSchema.parse({
  assetType: 'STOCK',
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
});
beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(target.toString());
  await migrateDatabase(target.toString());
  const p = await r.preview({
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    operation: {
      kind: 'ACCOUNT_UPSERT',
      account: {
        accountKey: 'margin',
        displayName: 'Margin',
        institution: 'Fixture',
        accountType: 'MARGIN',
        baseCurrency: 'USD',
        active: true,
        notes: '',
      },
      note: 'fixture',
      effectiveAt: '2026-01-01T00:00:00Z',
    },
  });
  await r.confirm(p.id, { version: 1, expectedRevision: 0, confirmed: true });
  const buy = await r.preview({
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    operation: {
      kind: 'STOCK_BUY',
      accountKey: 'margin',
      instrument: stock,
      quantity: '100',
      price: '100',
      fees: '0',
      note: 'fixture',
      effectiveAt: '2026-01-01T01:00:00Z',
    },
  });
  await r.confirm(buy.id, { version: 1, expectedRevision: 1, confirmed: true });
});
afterAll(async () => {
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
});
async function terminal(id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await chat.getRun(id);
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Run did not finish');
}
it('persists mode preference, canonical conversation and preview, with one explicit idempotent confirmation', async () => {
  const settings = await app.inject({ url: '/api/v1/settings/analysis' });
  expect(settings.json().data.effectiveDefault).toBe('standard');
  const update = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings/analysis',
    payload: { version: 1, expectedRevision: 0, defaultAnalysisMode: 'quick' },
  });
  expect(update.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/analysis',
        payload: {
          version: 1,
          expectedRevision: 0,
          defaultAnalysisMode: 'extensive',
        },
      })
    ).statusCode,
  ).toBe(409);
  const payload = {
    version: 1,
    idempotencyKey: randomUUID(),
    message:
      'sell to open 1 covered call AAPL expiry 2026-12-18 strike 200 premium 2 no fees standard 100-share contract',
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload,
  });
  expect(response.statusCode, response.body).toBe(202);
  const id = response.json().data.id as string,
    run = await terminal(id);
  expect(run.status, JSON.stringify(run.events)).toBe('completed');
  expect(run.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'completed' })]),
  );
  expect(run.analysisMode).toBe('quick');
  expect(run.previewId).toBeTruthy();
  expect(run).not.toHaveProperty('continuation');
  expect(run.estimatedCost).toBe('0.000000000000');
  expect((await r.overview()).revision).toBe(2);
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload,
  });
  expect(duplicate.json().data.id).toBe(id);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/chat/sessions/portfolio/runs',
        payload: { ...payload, message: 'different' },
      })
    ).statusCode,
  ).toBe(409);
  const replay = await app.inject({ url: `/api/v1/chat/runs/${id}/events` });
  expect(replay.headers['content-type']).toContain('text/event-stream');
  expect(replay.body).toContain('event: terminal');
  expect(replay.body).toContain('text_delta');
  const session = await chat.session('portfolio');
  expect(session.history.filter((i) => i.kind === 'tool_call')).toHaveLength(2);
  expect(session.history.filter((i) => i.kind === 'tool_result')).toHaveLength(
    2,
  );
  const draft = await chat.draft('portfolio', 'saved draft', session.revision);
  expect(draft.revision).toBeGreaterThan(session.revision);
  expect((await chat.session('portfolio')).draft).toBe('saved draft');
  const confirm = {
    version: 1 as const,
    expectedRevision: 2,
    confirmed: true as const,
  };
  await r.confirm(run.previewId!, confirm);
  await r.confirm(run.previewId!, confirm);
  const after = await r.overview();
  expect(after.revision).toBe(3);
  expect(after.state.positions.some((p) => p.quantity === '-1')).toBe(true);
  expect(after.state.cash[0]?.balance).toBe('-9800');
});
it('enforces durable concurrency, tool idempotence and conservative cost reservations', async () => {
  const claimInput = {
    context: 'general',
    requestKey: randomUUID(),
    message: 'hello',
    provider: 'fixture',
    model: 'fixture-v1',
    analysisMode: 'standard',
    policyVersion: 'v1',
    promptVersion: 'v1',
    adapterVersion: 'v1',
    effectiveLimits: {},
    portfolioRevision: 3,
    priceVersion: 'test',
  };
  const claim = await chat.claim(claimInput);
  expect(claim.lease).toBeTruthy();
  try {
    await expect(
      chat.claim({ ...claimInput, requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    let executions = 0;
    expect(
      await chat.tool(claim.run.id, 'call-1', { x: 1 }, async () => {
        executions++;
        return { value: 42 };
      }),
    ).toEqual({ value: 42 });
    await chat.tool(claim.run.id, 'call-1', { x: 1 }, async () => {
      executions++;
      return null;
    });
    expect(executions).toBe(1);
    await expect(
      chat.tool(claim.run.id, 'call-1', { x: 2 }, async () => null),
    ).rejects.toMatchObject({ code: 'TOOL_ID_REUSED' });
    await chat.reserve(claim.run.id, '0.5', '1', '1');
    await expect(
      chat.reserve(claim.run.id, '0.6', '1', '1'),
    ).rejects.toMatchObject({ code: 'RUN_COST_LIMIT' });
    await expect(
      chat.reserve(claim.run.id, '0.6', null, '1'),
    ).rejects.toMatchObject({ code: 'DAILY_COST_LIMIT' });
    await chat.recordUsage(claim.run.id, null, '0.5', null);
    expect((await chat.getRun(claim.run.id)).reservedCost).toBe(
      '0.500000000000',
    );
    const preview = await r.preview({
      expectedRevision: 3,
      idempotencyKey: `chat:${claim.run.id}:tool`,
      operation: {
        kind: 'CASH_DEPOSIT',
        accountKey: 'margin',
        currency: 'USD',
        amount: '1',
        effectiveAt: new Date().toISOString(),
        note: 'uncompleted run',
      },
    });
    await expect(
      r.confirm(preview.id, {
        version: 1,
        expectedRevision: 3,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PREVIEW_NOT_READY' });
    await r.reject(preview.id);
    await chat.cancel(claim.run.id);
    expect((await chat.getRun(claim.run.id)).cancelRequested).toBe(true);
    await chat.finish(claim.run.id, 'cancelled', 'LLM_CANCELLED', null);
  } finally {
    await claim.lease!.release();
  }
});
it('blocks direct browser writes and cost-capped inference without price metadata', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/chat/sessions/general/runs',
        headers: { origin: 'https://untrusted.example' },
        payload: { version: 1, idempotencyKey: randomUUID(), message: 'hello' },
      })
    ).statusCode,
  ).toBe(403);
  const capped = buildApp(
    database.repository,
    readConfig({
      DATABASE_URL: target.toString(),
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-5.4-mini',
      LLM_MAX_RUN_COST_USD: '1',
    }),
    false,
    r,
    { key: 'test-only-never-sent', chat },
  );
  try {
    const result = await capped.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/general/runs',
      payload: { version: 1, idempotencyKey: randomUUID(), message: 'hello' },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('PRICE_DATA_UNAVAILABLE');
  } finally {
    await capped.close();
  }
});

it('recovers interrupted histories and retains uncertain costs across process restart', async () => {
  const claim = await chat.claim({
    context: 'journal',
    requestKey: randomUUID(),
    message: 'test recovery',
    provider: 'fixture',
    model: 'fixture-v1',
    analysisMode: 'standard',
    policyVersion: 'v1',
    promptVersion: 'v1',
    adapterVersion: 'v1',
    effectiveLimits: {},
    portfolioRevision: 3,
    priceVersion: 'test',
  });
  await chat.checkpoint(
    claim.run.id,
    [
      ...claim.lease!.history,
      {
        id: randomUUID(),
        kind: 'tool_call',
        callId: 'pending',
        name: 'portfolio_read_v1',
        arguments: {},
      },
    ],
    undefined,
  );
  await chat.reserve(claim.run.id, '0.25', null, null);
  await claim.lease!.release();
  await chat.recover();
  const recovered = await chat.getRun(claim.run.id);
  expect(recovered.status).toBe('interrupted');
  expect(recovered.reservedCost).toBe('0.250000000000');
  expect((await chat.session('journal')).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_result', callId: 'pending' }),
    ]),
  );
  await chat.reset('journal');
  expect((await chat.session('journal')).history).toEqual([]);
  expect((await chat.getRun(claim.run.id)).status).toBe('interrupted');
});

it('persists sanitized request diagnostics and a single no-change notice', async () => {
  const { OpenAiProvider } = await import('../packages/llm/dist/index.js');
  const provider = new OpenAiProvider(
    'fake-offline-key',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_function_parameters',
            param: 'tools[1].parameters',
            type: 'invalid_request_error',
            message: 'private diagnostic text',
          },
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_offline_schema',
          },
        },
      ),
  );
  const failedApp = buildApp(
    database.repository,
    readConfig({
      DATABASE_URL: target.toString(),
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-5.4-mini',
    }),
    false,
    r,
    { chat, provider, key: 'fake-offline-key' },
  );
  try {
    const response = await failedApp.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/risk/runs',
      payload: { version: 1, idempotencyKey: randomUUID(), message: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    const run = await terminal(response.json().data.id as string);
    expect(run.status).toBe('failed');
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          diagnostics: {
            providerCode: 'invalid_function_parameters',
            parameter: 'tools[1].parameters',
            requestId: 'req_offline_schema',
          },
        }),
      ]),
    );
    const last = (await chat.session('risk')).history.at(-1);
    expect(last?.kind).toBe('text');
    if (last?.kind === 'text') {
      expect(
        last.text.match(/No portfolio change was committed\./g),
      ).toHaveLength(1);
      expect(last.text).not.toContain('private diagnostic text');
    }
  } finally {
    await failedApp.close();
  }
});

it('applies a late trade once after explicit inclusion confirmation and preserves older history', async () => {
  const current = await r.overview(),
    beforeHistory = await r.history();
  const input = {
    expectedRevision: current.revision,
    idempotencyKey: randomUUID(),
    operation: {
      kind: 'STOCK_SELL' as const,
      accountKey: 'margin',
      instrument: stock,
      quantity: '1',
      price: '200',
      fees: '0',
      transactionDate: '2026-10-01',
      effectiveAt: new Date().toISOString(),
      note: 'Late reported sale',
    },
  };
  const preview = await r.preview(input);
  expect((await r.overview()).state).toEqual(current.state);
  expect(preview.operation).toMatchObject({ transactionDate: '2026-10-01' });
  const confirm = {
    version: 1 as const,
    expectedRevision: current.revision,
    confirmed: true as const,
  };
  await expect(r.confirm(preview.id, confirm)).rejects.toMatchObject({
    code: 'TRADE_INCLUSION_CONFIRMATION_REQUIRED',
  });
  expect((await r.overview()).revision).toBe(current.revision);
  await r.confirm(preview.id, { ...confirm, tradeNotAlreadyIncluded: true });
  await r.confirm(preview.id, { ...confirm, tradeNotAlreadyIncluded: true });
  const after = await r.overview();
  expect(after.revision).toBe(current.revision + 1);
  expect(
    after.state.positions.find((p) => p.instrument.assetType === 'STOCK')
      ?.quantity,
  ).toBe('99');
  expect(
    Number(after.state.cash[0]?.balance) -
      Number(current.state.cash[0]?.balance),
  ).toBe(200);
  const history = await r.history();
  expect(history.slice(1)).toEqual(beforeHistory);
  expect(history[0]?.note).toContain('Trade date: 2026-10-01');
  const events = await database.pool.query<{
    operation: { transactionDate: string };
  }>('select operation from portfolio_events where preview_id=$1', [
    preview.id,
  ]);
  expect(events.rows[0]?.operation.transactionDate).toBe('2026-10-01');
  expect((await r.preview(input)).id).toBe(preview.id);
});

it('persists holding context and previews a shorthand sale without committing', async () => {
  const { instrumentKey } = await import('../packages/portfolio/src/index.js');
  const holdingContext = {
    accountKey: 'margin',
    instrumentKey: instrumentKey(stock),
  };
  const before = await r.overview();
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      message: 'sold 3 shares',
      holdingContext,
    },
  });
  expect(first.statusCode).toBe(202);
  const question = await terminal(first.json().data.id);
  expect(question.previewId).toBeNull();
  const key = randomUUID();
  const payload = {
    version: 1,
    idempotencyKey: key,
    message: 'at 200 no fees',
    holdingContext,
  };
  const next = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload,
  });
  expect(next.statusCode).toBe(202);
  const run = await terminal(next.json().data.id);
  expect(run.status).toBe('completed');
  expect(run.previewId).toBeTruthy();
  const preview = await r.getPreview(run.previewId!);
  expect(preview.operation).toMatchObject({
    kind: 'STOCK_SELL',
    accountKey: 'margin',
    quantity: '3',
    price: '200',
    fees: '0',
  });
  expect((await r.overview()).revision).toBe(before.revision);
  const session = await app.inject({
    method: 'GET',
    url: '/api/v1/chat/sessions/portfolio',
  });
  expect(session.json().data.history).toContainEqual(
    expect.objectContaining({
      kind: 'text',
      text: 'at 200 no fees',
      holdingContext,
    }),
  );
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload: {
      ...payload,
      holdingContext: { ...holdingContext, accountKey: 'different' },
    },
  });
  expect(conflict.statusCode).toBe(409);
  await r.reject(preview.id);
});

it('accepts account-only context and reads quantities without a preview or model calls', async () => {
  const before = await r.overview();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/portfolio/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      message: 'how many aapl?',
      holdingContext: { accountKey: 'margin' },
    },
  });
  expect(response.statusCode).toBe(202);
  const run = await terminal(response.json().data.id);
  expect(run.status).toBe('completed');
  expect(run.previewId).toBeNull();
  const session = await app.inject({
    method: 'GET',
    url: '/api/v1/chat/sessions/portfolio',
  });
  expect(session.json().data.history.at(-1).text).toContain('99 AAPL shares');
  expect((await r.overview()).revision).toBe(before.revision);
});

it('captures language and mode per reply, preserves history, and keeps daily accounting cumulative', async () => {
  await chat.reset('general');
  const before = await r.overview();
  const sends = [];
  for (const [analysisMode, outputLanguage] of [
    ['quick', 'en'],
    ['extensive', 'zh-CN'],
  ] as const) {
    const payload = {
      version: 1,
      idempotencyKey: randomUUID(),
      message: sends.length ? 'Continue the previous question' : 'hello',
      analysisMode,
      outputLanguage,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/general/runs',
      payload,
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await terminal(response.json().data.id);
    expect(run.status).toBe('completed');
    expect(run.analysisMode).toBe(analysisMode);
    expect(run.outputLanguage).toBe(outputLanguage);
    sends.push(run);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/general/runs',
      payload,
    });
    expect(repeated.json().data.id).toBe(run.id);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/general/runs',
      payload: {
        ...payload,
        outputLanguage: outputLanguage === 'en' ? 'zh-CN' : 'en',
      },
    });
    expect(conflict.statusCode).toBe(409);
  }
  const session = (await app.inject('/api/v1/chat/sessions/general')).json()
    .data;
  expect(
    session.history.filter((i: { role?: string }) => i.role === 'user'),
  ).toHaveLength(2);
  expect(session.dailyUsage.replies).toBeGreaterThanOrEqual(2);
  expect(
    session.runs.map((r: { outputLanguage: string }) => r.outputLanguage),
  ).toEqual(['zh-CN', 'en']);
  const settings = await chat.settings();
  const changed = await app.inject({
    method: 'PATCH',
    url: '/api/v1/settings/analysis',
    payload: {
      version: 1,
      expectedRevision: settings.revision,
      outputLanguage: 'zh-CN',
    },
  });
  expect(changed.statusCode).toBe(200);
  expect((await chat.settings()).defaultAnalysisMode).toBe(
    settings.defaultAnalysisMode,
  );
  expect((await chat.getRun(sends[0]!.id)).outputLanguage).toBe('en');
  await chat.updateSettings(settings.revision + 1, undefined, 'en');
  // Preferences are restored for following tests; revisions remain monotonic.
  expect(await r.overview()).toEqual(before);
});

it('allows a fresh run cost ceiling on the next send while retaining daily usage after reset', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const claimed = await chat.claim({
      context: 'risk',
      requestKey: randomUUID(),
      message: 'Synthetic cost test',
      provider: 'fixture',
      model: 'fixture-v1',
      analysisMode: 'quick',
      policyVersion: 'test',
      promptVersion: 'test',
      adapterVersion: 'test',
      effectiveLimits: {},
      portfolioRevision: (await r.overview()).revision,
      priceVersion: 'synthetic-test',
    });
    try {
      await chat.reserve(claimed.run.id, '0.30', '0.30', null);
      expect((await chat.getRun(claimed.run.id)).reservedCost).toBe(
        '0.300000000000',
      );
      ids.push(claimed.run.id);
      await chat.finish(claimed.run.id, 'completed', null, null);
    } finally {
      await claimed.lease?.release();
    }
  }
  const usage = await chat.dailyUsage();
  await expect(
    chat.reserve(ids[1]!, '0.01', null, usage.budgetedCost),
  ).rejects.toMatchObject({ code: 'DAILY_COST_LIMIT' });
  const reset = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/risk/reset',
    payload: {},
  });
  expect(reset.json().data.dailyUsage).toEqual(usage);
});
