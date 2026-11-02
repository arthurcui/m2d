import process from 'node:process';
import { URL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import { readConfig } from '../packages/config/dist/index.js';
import {
  ChatFixtureProvider,
  OpenAiProvider,
  supportedModels,
} from '../packages/llm/dist/index.js';
import { SecResearchProvider } from '../packages/research/dist/index.js';
import { createResearchService } from '../apps/api/dist/research.js';
import { createResearchSearchService } from '../apps/api/dist/research-search.js';
import { buildApp } from '../apps/api/dist/app.js';

// Opt-in only; never invoked by offline CI or the normal test commands.
const live = process.argv.includes('--live');
if (!live)
  throw new Error('This real-filing evaluation requires explicit --live.');
if (process.argv.slice(2).some((arg) => arg !== '--live'))
  throw new Error('Only --live is supported.');
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a disposable PostgreSQL/pgvector server. No application database fallback is allowed.',
  );
const key = process.env.OPENAI_API_KEY?.trim() ?? '';
if (
  live &&
  (!key ||
    process.env.LLM_PROVIDER !== 'openai' ||
    !supportedModels.includes(process.env.LLM_MODEL))
)
  throw new Error(
    'Live evaluation requires the existing backend OpenAI key/provider and a supported configured chat model.',
  );
const baseline = readConfig({ ...process.env, DATABASE_URL: url });
// Smaller explicit evaluation ceilings; never raise the deployment ceilings.
const smallerCost = (configured, cap) =>
  configured !== undefined && Number(configured) < Number(cap)
    ? configured
    : cap;
const config = {
  ...baseline,
  LLM_PROVIDER: live ? 'openai' : 'fixture',
  LLM_MODEL: live ? baseline.LLM_MODEL : 'fixture-v1',
  LLM_MAX_STEPS: Math.min(baseline.LLM_MAX_STEPS, 5),
  LLM_MAX_TOOL_CALLS: Math.min(baseline.LLM_MAX_TOOL_CALLS, 4),
  LLM_MAX_OUTPUT_TOKENS: Math.min(baseline.LLM_MAX_OUTPUT_TOKENS, 1024),
  LLM_RUN_TIMEOUT_MS: Math.min(baseline.LLM_RUN_TIMEOUT_MS, 45000),
  LLM_REQUEST_TIMEOUT_MS: Math.min(baseline.LLM_REQUEST_TIMEOUT_MS, 20000),
  LLM_MAX_RUN_COST_USD: smallerCost(baseline.LLM_MAX_RUN_COST_USD, '0.25'),
  LLM_DAILY_BUDGET_USD: smallerCost(baseline.LLM_DAILY_BUDGET_USD, '0.25'),
  // Verified official standard pricing for the supported configured model family.
  LLM_INPUT_USD_PER_MILLION: baseline.LLM_INPUT_USD_PER_MILLION ?? '0.75',
  LLM_OUTPUT_USD_PER_MILLION: baseline.LLM_OUTPUT_USD_PER_MILLION ?? '4.50',
  LLM_PRICE_VERSION:
    baseline.LLM_PRICE_VERSION ?? 'openai-gpt-5.4-mini-2026-10-31',
};
const provider = live ? new OpenAiProvider(key) : new ChatFixtureProvider();
const admin = createDatabase(url),
  name = `m2d_filings_eval_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString());
config.DATABASE_URL = target.toString();
const search = createResearchSearchService(db.researchSearch, provider, {
  dailyBytes: Math.min(baseline.RESEARCH_EMBEDDING_DAILY_BYTES, 20000),
  dailyBudget: config.LLM_DAILY_BUDGET_USD,
});
let httpCalls = 0;
const service = createResearchService(
  db.research,
  new SecResearchProvider(baseline.SEC_USER_AGENT, async (url, options) => {
    assert(++httpCalls <= 10, 'SEC ten-request ceiling');
    return globalThis.fetch(url, options);
  }),
  search,
);
const app = buildApp(db.repository, config, false, db.portfolio, {
  chat: db.chat,
  research: service,
  key: live ? key : '',
});
const report = {
  version: 1,
  at: new Date().toISOString(),
  provider: provider.id,
  embeddingModel: null,
  chatModel: config.LLM_MODEL,
  semanticQualityEvaluated: false,
  mode: 'standard',
  ceilings: {
    runUsd: config.LLM_MAX_RUN_COST_USD,
    totalUsd: config.LLM_DAILY_BUDGET_USD,
    modelAttempts: config.LLM_MAX_STEPS,
    toolCalls: config.LLM_MAX_TOOL_CALLS,
    outputTokens: config.LLM_MAX_OUTPUT_TOKENS,
    runMilliseconds: config.LLM_RUN_TIMEOUT_MS,
  },
  corpus:
    'Live SEC NVDA and MSFT filings/companyfacts; isolated database, no user data',
  queries: [],
  checks: {},
  agent: [],
  usage: null,
  passed: false,
};
let created = false;
async function agentQuestion(symbol, message, outputLanguage = 'en') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/research/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      analysisMode: 'standard',
      researchContext: { symbol },
      outputLanguage,
      message,
    },
  });
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json().data.id;
  let run;
  for (let i = 0; i < 260; i++) {
    run = await db.chat.getRun(id);
    if (run.status !== 'running') break;
    await delay(200);
  }
  const session = await db.chat.session('research');
  const answer =
    session.history.findLast(
      (item) => item.kind === 'text' && item.role === 'assistant',
    )?.text ?? '';
  const saved = {
    status: run.status,
    error: run.error ?? null,
    mode: run.analysisMode,
    usage: run.usage,
    cost: run.reservedCost,
    answer,
    tools: session.history
      .filter((item) => item.kind === 'tool_call')
      .map((item) => item.name),
    trace: session.history.filter(
      (item) => item.kind === 'tool_call' || item.kind === 'tool_result',
    ),
  };
  report.agent.push(saved);
  assert.equal(
    run.status,
    'completed',
    JSON.stringify({ status: run.status, error: run.error }),
  );
  assert.equal(run.previewId, null);
  return saved;
}
try {
  await admin.pool.query(`create database "${name}"`);
  created = true;
  await migrateDatabase(target.toString());
  const historical = new Date().toISOString();
  await delay(10);
  const cases = [
    {
      symbol: 'NVDA',
      end: '2025-01-26',
      value: '130497000000',
      query: 'customer concentration',
    },
    {
      symbol: 'MSFT',
      end: '2025-06-30',
      value: '281724000000',
      query: 'cybersecurity',
    },
  ];
  for (const c of cases) {
    const id = randomUUID();
    await service.start({ symbol: c.symbol, idempotencyKey: id });
    await service.close();
    const job = await db.research.import(id);
    assert.equal(job.status, 'completed', job.error);
    const documents = await db.research.timeline(c.symbol);
    assert.equal(documents.length, 4);
    for (const d of documents) {
      const raw = await db.research.raw(d.id);
      assert.equal(createHash('sha256').update(raw.data).digest('hex'), d.hash);
    }
    const facts = await service.tool('research_query_facts_v2', {
      symbol: c.symbol,
      metric: 'Revenue',
      unit: 'USD',
      periodFrom: c.end,
      periodTo: c.end,
      limit: 40,
    });
    assert(
      facts.facts.some(
        (f) =>
          f.value === c.value && f.period_end === c.end && f.unit === 'USD',
      ),
      'Known annual revenue must match preserved SEC facts',
    );
    const hits = await search.search({
      symbol: c.symbol,
      query: c.query,
      mode: 'keyword',
    });
    assert(hits.hits.length > 0, 'Real filing risk passage missing');
    assert(hits.hits.every((h) => h.symbol === c.symbol));
    const passage = hits.hits[0];
    const read = await service.tool('research_read_passage_v1', {
      documentId: passage.document_id,
      chunkIndex: passage.chunk_index,
    });
    assert(read.passages.some((p) => p.text === passage.text));
    const earlier = await search.search({
      symbol: c.symbol,
      query: c.query,
      mode: 'keyword',
      at: historical,
    });
    assert.equal(earlier.hits.length, 0);
    const filings = documents.filter((d) => /^10-[KQ]/.test(d.form));
    assert.equal(filings.length, 2);
    const comparison = await service.compare(filings[1].id, filings[0].id);
    assert(comparison.added.length + comparison.removed.length > 0);
    report.queries.push({
      symbol: c.symbol,
      documents: documents.length,
      forms: filings.map((d) => d.form),
      groundTruth: { periodEnd: c.end, revenueUsd: c.value },
      riskPassage: passage.citation,
      comparisonChanges: comparison.added.length + comparison.removed.length,
      historicalIsolation: true,
    });
    process.stdout.write(
      `SEC ${c.symbol}: originals, exact annual revenue, risk retrieval, comparison and historical cutoff passed.\n`,
    );
  }
  for (const c of cases) {
    await db.chat.reset('research');
    const answer = await agentQuestion(
      c.symbol,
      `Using stored SEC financial facts only, what was total revenue in USD for the full fiscal year ending ${c.end}? Preserve the full dollar amount (not rounded billions), unit, reporting period and source citation. Distinguish the annual value from shorter periods ending on the same date.`,
      c.symbol === 'MSFT' ? 'zh-CN' : 'en',
    );
    assert(
      answer.answer.replaceAll(',', '').includes(c.value),
      'Advisor annual revenue mismatch',
    );
    assert(
      answer.answer.includes('/research?document='),
      'Advisor missing preserved evidence citation',
    );
    if (c.symbol === 'MSFT')
      assert(/[\u4e00-\u9fff]/.test(answer.answer), 'Chinese answer missing');
  }
  await db.chat.reset('research');
  const absent = await agentQuestion(
    'NVDA',
    'What is the CEO�s favorite breakfast cereal? Use only stored evidence. If absent, start with NO_SIGNAL and explain what is missing.',
  );
  assert(/^\s*NO_SIGNAL\b/.test(absent.answer));
  assert.equal((await db.portfolio.overview()).revision, 0);
  report.checks = {
    exactRevenueAnswers: 2,
    language: 'English and Simplified Chinese',
    abstention: true,
    financialStateUnchanged: true,
    httpCalls,
  };
  report.passed = true;
} catch (error) {
  report.failure = {
    code: typeof error.code === 'string' ? error.code : 'EVALUATION_FAILED',
    message: key
      ? String(error.message).replaceAll(key, '[REDACTED]')
      : String(error.message),
  };
  process.exitCode = 1;
} finally {
  await app.close();
  if (created) {
    const embedding = await db.researchSearch.dailyUsage();
    const total = await db.pool.query(
      'select (coalesce((select sum(reserved_cost) from agent_runs),0)+coalesce((select sum(cost) from research_embedding_usage where agent_run_id is null),0))::text total',
    );
    report.usage = { embedding, totalEstimatedUsd: total.rows[0].total };
  }
  await db.close();
  if (created) await admin.pool.query(`drop database "${name}"`);
  await admin.close();
  await mkdir('.tmp', { recursive: true });
  const path = `.tmp/real-filings-${live ? 'live' : 'fixture'}-report.json`;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    path.replace('-report.json', `-${report.at.replaceAll(':', '-')}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      provider: provider.id,
      metrics: report.metrics,
      checks: report.checks,
      usage: report.usage,
      failure: report.failure,
      report: path,
    }) + '\n',
  );
}
