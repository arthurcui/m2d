import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
import { log } from 'node:console';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import { readConfig } from '../packages/config/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { createRiskService } from '../apps/api/dist/risk.js';
import {
  sevenAccountFixture,
  workbook,
  parseWorkbook,
} from '../packages/ingestion/dist/index.js';
import { OpenAiProvider } from '../packages/llm/dist/index.js';

// Explicit, bounded live verification in a disposable database. Never sends portfolio data.
const draftOnly = process.argv[3] === '--draft-only';
if (
  process.argv[2] !== '--live' ||
  (process.argv.length !== 3 && !(process.argv.length === 4 && draftOnly))
)
  throw new Error(
    'Pass --live explicitly and provide TEST_DATABASE_URL for disposable PostgreSQL.',
  );
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required.');
const key = process.env.OPENAI_API_KEY?.trim();
if (!key || process.env.LLM_PROVIDER !== 'openai')
  throw new Error('Configured backend OpenAI credentials are required.');
const baseline = readConfig({ ...process.env, DATABASE_URL: url });
const cap = (value) =>
  value !== undefined && Number(value) < 0.25 ? value : '0.25';
const config = {
  ...baseline,
  LLM_MAX_STEPS: Math.min(baseline.LLM_MAX_STEPS, 4),
  LLM_MAX_TOOL_CALLS: Math.min(baseline.LLM_MAX_TOOL_CALLS, 4),
  LLM_MAX_OUTPUT_TOKENS: Math.min(baseline.LLM_MAX_OUTPUT_TOKENS, 1024),
  LLM_RUN_TIMEOUT_MS: Math.min(baseline.LLM_RUN_TIMEOUT_MS, 45000),
  LLM_REQUEST_TIMEOUT_MS: Math.min(baseline.LLM_REQUEST_TIMEOUT_MS, 20000),
  LLM_MAX_RUN_COST_USD: cap(baseline.LLM_MAX_RUN_COST_USD),
  LLM_DAILY_BUDGET_USD: cap(baseline.LLM_DAILY_BUDGET_USD),
};
// Same documented evaluation rates as evaluate-research-sources.mjs; never replace configured rates.
if (baseline.LLM_MODEL.startsWith('gpt-5.4-mini')) {
  config.LLM_INPUT_USD_PER_MILLION ??= '0.75';
  config.LLM_OUTPUT_USD_PER_MILLION ??= '4.50';
  config.LLM_PRICE_VERSION ??= 'openai-gpt-5.4-mini-2026-10-31';
}
if (
  !config.LLM_INPUT_USD_PER_MILLION ||
  !config.LLM_OUTPUT_USD_PER_MILLION ||
  !config.LLM_PRICE_VERSION
)
  throw new Error(
    'Provide configured model price rates to enforce the evaluation cost cap.',
  );
const admin = createDatabase(url),
  name = `m2d_risk_eval_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
config.DATABASE_URL = target.toString();
const db = createDatabase(target.toString());
let app,
  created = false;
const report = {
  provider: 'openai',
  model: config.LLM_MODEL,
  priceVersion: config.LLM_PRICE_VERSION,
  inputUsdPerMillion: config.LLM_INPUT_USD_PER_MILLION,
  outputUsdPerMillion: config.LLM_OUTPUT_USD_PER_MILLION,
  capUsd: config.LLM_DAILY_BUDGET_USD,
  runs: [],
  modelRequests: [],
};
try {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  await migrateDatabase(target.toString());
  const bytes = await workbook(sevenAccountFixture()),
    parsed = await parseWorkbook(bytes);
  const staged = await db.portfolio.importWorkbook({
    ...parsed,
    bytes,
    effectiveAt: '2026-01-01T00:00:00Z',
    expectedRevision: 0,
    templateVersion: 1,
  });
  await db.portfolio.confirm(staged.preview.id, {
    version: 1,
    confirmed: true,
    expectedRevision: 0,
    fullReplacementAcknowledged: true,
  });
  const provider = new OpenAiProvider(key);
  const stream = provider.stream.bind(provider);
  let expectedLanguage = 'en';
  provider.stream = async function* (request, signal) {
    const language = request.instructions.includes(
      'Output language: Simplified Chinese',
    )
      ? 'zh-CN'
      : 'en';
    report.modelRequests.push({
      mode: request.analysisMode,
      language,
      hasContinuation: Boolean(request.continuation),
    });
    assert.equal(
      language,
      expectedLanguage,
      'Language must reach the provider request.',
    );
    yield* stream(request, signal);
  };
  app = buildApp(db.repository, config, false, db.portfolio, {
    chat: db.chat,
    key,
    provider,
    risk: createRiskService(db.portfolio, db.risk),
  });
  const before = await db.portfolio.overview();
  for (const [analysisMode, outputLanguage, message, expected, tool] of [
    [
      'standard',
      'en',
      'Hypothetical planning only. Use stock_trade_evaluate_v1: buy 2 AAPL shares in DEMO1 at USD 200, total fees USD 1, stop USD 190, target USD 220, risk budget USD 100. Use the recorded NASDAQ stock identity. State calculated stop-based risk and maximum whole shares under budget. State main risk and invalidation. Do not record a trade.',
      '21',
      'stock_trade_evaluate_v1',
    ],
    [
      'standard',
      'en',
      'Hypothetical planning only. Use stock_trade_evaluate_v1 to sell 3 existing AAPL shares from DEMO1 at USD 200, total fees USD 1. Stop, target and risk budget are unknown/null. State remaining shares and cash proceeds, main risk and invalidation. Do not record a trade.',
      '97',
      'stock_trade_evaluate_v1',
    ],
    [
      'standard',
      'en',
      'Hypothetical planning only. Use strategy_evaluate_v1: a covered call in DEMO1 with 100 AAPL NASDAQ USD shares at reference price 150 and one short standard 100-share CALL, underlying AAPL, strike 160, expiry 2027-01-15, premium 2 per share. Total fees 1, slippage 0. State exact maximum profit/loss and break-even from the calculator, main risk and exit/invalidation. Do not record a trade.',
      '1199',
      'strategy_evaluate_v1',
    ],
    [
      'standard',
      'en',
      'Create an unsaved hypothetical STOCK BUY plan draft with trade_plan_preview_v1. Account DEMO1, buy 2 AAPL NASDAQ USD shares at 200, fees 1, slippage 0, stop 190, target price 220, risk budget 100. Entry condition: price reaches 200. Exit: target 220 or stop 190. Invalidation: price below 190. Main risk: earnings gap through stop. Portfolio reviewed true. Explicitly call the preview tool and say WATCH_ONLY. Do not save or record a trade.',
      'WATCH_ONLY',
      'trade_plan_preview_v1',
    ],
  ]) {
    if (draftOnly && tool !== 'trade_plan_preview_v1') continue;
    if (tool === 'trade_plan_preview_v1') await db.chat.reset('risk');
    expectedLanguage = outputLanguage;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/risk/runs',
      payload: {
        version: 1,
        idempotencyKey: randomUUID(),
        analysisMode,
        outputLanguage,
        message,
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().data.id,
      deadline = Date.now() + 60000;
    let run;
    do {
      await delay(100);
      run = await db.chat.getRun(id);
    } while (run.status === 'running' && Date.now() < deadline);
    const session = await db.chat.session('risk');
    const answer =
      session.history.findLast(
        (i) => i.kind === 'text' && i.role === 'assistant',
      )?.text ?? '';
    report.runs.push({
      analysisMode: run.analysisMode,
      outputLanguage: run.outputLanguage,
      status: run.status,
      limits: run.effectiveLimits,
      usage: run.usage,
      estimatedCost: run.estimatedCost,
      previewId: run.previewId,
      answer,
    });
    assert.equal(run.status, 'completed', JSON.stringify(run.limitReasons));
    assert.equal(run.analysisMode, analysisMode);
    assert.equal(run.outputLanguage, outputLanguage);
    assert.equal(run.previewId, null);
    if (tool === 'strategy_evaluate_v1') {
      assert(
        !/invalidated on the upside|invalidated.*above.*160/i.test(answer),
        'Profit cap is not invalidation',
      );
    }
    assert(
      answer.replaceAll(',', '').includes(expected),
      'Expected deterministic value missing',
    );
    assert(
      session.history.some((i) => i.kind === 'tool_call' && i.name === tool),
      'Required deterministic tool not called',
    );
  }
  const session = await db.chat.session('risk');
  assert.equal(
    session.history.filter((i) => i.kind === 'text' && i.role === 'user')
      .length,
    1,
  );
  assert.deepEqual(await db.portfolio.overview(), before);
  report.dailyUsage = await db.chat.dailyUsage();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error).replaceAll(key, '[redacted]');
  process.exitCode = 1;
} finally {
  await app?.close();
  await db.close();
  if (created) await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
  await mkdir('.tmp', { recursive: true });
  await writeFile(
    '.tmp/m5-risk-live-report.json',
    JSON.stringify(report, null, 2),
  );
  log(JSON.stringify(report, null, 2));
}
