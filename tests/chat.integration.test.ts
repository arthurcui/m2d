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
