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
import { OpenAiProvider } from '../packages/llm/dist/index.js';

// Explicit, bounded live verification in a disposable database. Never sends portfolio data.
if (process.argv.length !== 3 || process.argv[2] !== '--live')
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
  LLM_MAX_STEPS: Math.min(baseline.LLM_MAX_STEPS, 2),
  LLM_MAX_TOOL_CALLS: Math.min(baseline.LLM_MAX_TOOL_CALLS, 2),
  LLM_MAX_OUTPUT_TOKENS: Math.min(baseline.LLM_MAX_OUTPUT_TOKENS, 512),
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
  name = `m2d_advisor_eval_${randomUUID().replaceAll('-', '')}`,
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
  });
  const before = await db.portfolio.overview();
  for (const [analysisMode, outputLanguage, message] of [
    [
      'quick',
      'en',
      'Remember the label M2D-CONTEXT-42. In one short sentence, explain the difference between revenue and profit. No tools, account reads or trading advice.',
    ],
    [
      'extensive',
      'zh-CN',
      'What label did I give you in my previous message? Briefly explain revenue versus profit again. No tools or trading advice.',
    ],
  ]) {
    expectedLanguage = outputLanguage;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions/general/runs',
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
    const session = await db.chat.session('general');
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
    assert.match(
      answer,
      outputLanguage === 'en' ? /revenue|profit/i : /[\u4e00-\u9fff]/,
    );
    if (outputLanguage === 'zh-CN') assert.match(answer, /M2D-CONTEXT-42/);
  }
  const session = await db.chat.session('general');
  assert.equal(
    session.history.filter((i) => i.kind === 'text' && i.role === 'user')
      .length,
    2,
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
    '.tmp/advisor-live-report.json',
    JSON.stringify(report, null, 2),
  );
  log(JSON.stringify(report, null, 2));
}
