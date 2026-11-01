import process from 'node:process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import { readConfig } from '../packages/config/dist/index.js';
import {
  ChatFixtureProvider,
  OpenAiProvider,
  supportedModels,
} from '../packages/llm/dist/index.js';
import { FixtureResearchProvider } from '../packages/research/dist/index.js';
import { createResearchService } from '../apps/api/dist/research.js';
import { createResearchSearchService } from '../apps/api/dist/research-search.js';
import { buildApp } from '../apps/api/dist/app.js';

// Opt-in only; never invoked by offline CI or the normal test commands.
const live = process.argv.includes('--live');
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
  name = `m2d_search_eval_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString());
config.DATABASE_URL = target.toString();
const search = createResearchSearchService(db.researchSearch, provider, {
  dailyBytes: Math.min(baseline.RESEARCH_EMBEDDING_DAILY_BYTES, 20000),
  dailyBudget: config.LLM_DAILY_BUDGET_USD,
});
const service = createResearchService(
  db.research,
  new FixtureResearchProvider(),
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
  embeddingModel: live ? 'text-embedding-3-small' : 'fixture-embedding-v1',
  chatModel: config.LLM_MODEL,
  semanticQualityEvaluated: live,
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
    'Authored fictional Aster Devices reports; no user documents or portfolio data',
  queries: [],
  checks: {},
  agent: [],
  usage: null,
  passed: false,
};
let created = false;
const docs = new Map();
async function upload(key, text, { symbol = 'M4EVAL', facts = [] } = {}) {
  const id = randomUUID();
  await service.start({
    idempotencyKey: id,
    symbol,
    upload: {
      key,
      title: key,
      form: 'REPORT',
      url: null,
      publishedAt: '2026-01-01T00:00:00Z',
      mime: 'text/plain',
      raw: Buffer.from(
        `SYNTHETIC EVALUATION DOCUMENT — fictional Aster Devices.\n${text}`,
      ),
      facts,
    },
  });
  await service.close();
  const job = await db.research.import(id);
  assert.equal(job.status, 'completed', job.error ?? 'Import failed');
  const doc = job.document_ids[0];
  docs.set(doc, key);
  return doc;
}
async function agentQuestion(message) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/research/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      analysisMode: 'standard',
      researchContext: { symbol: 'M4EVAL' },
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
  assert.equal(run.status, 'completed', JSON.stringify(saved));
  assert.equal(run.previewId, null);
  return saved;
}
try {
  await admin.pool.query(`create database "${name}"`);
  created = true;
  await migrateDatabase(target.toString());
  const liquidity = await upload(
    'Liquidity and funding',
    'Unrestricted cash and committed facilities can sustain operations for only six months. Additional financing is not secured; without new funding the company cannot continue at its current spending level.',
  );
  await upload(
    'Supply resilience',
    'All ceramic substrates are manufactured at one supplier factory. An earthquake or prolonged outage at that site would stop production because no alternative source is qualified.',
  );
  await upload(
    'Customer concentration',
    'One customer accounted for 43 percent of net sales. Its supply contract expires next quarter, and nonrenewal would materially reduce revenue.',
  );
  await upload(
    'Unit economics',
    'Gross margin declined from 34 percent to 27 percent because higher semiconductor input costs were not recovered through selling prices.',
  );
  await upload(
    'Debt maturity',
    'A USD 80 million term loan falls due in March. The maturity is a bullet repayment; negotiations to roll over the principal have not concluded.',
  );
  await upload(
    'Equity issuance',
    'Fifteen million new ordinary shares were issued. Shares outstanding rose from 100 million to 115 million, reducing each existing shareholder’s proportional ownership.',
  );
  const exact = await upload(
    'Reported revenue',
    'Reported revenue for the six months ended June 30 is USD 12345678.90123456789.',
    {
      facts: [
        {
          metric: 'us-gaap:Revenues',
          unit: 'USD',
          start: '2026-01-01',
          end: '2026-06-30',
          value: '12345678.90123456789',
          accession: 'synthetic-001',
          filed: '2026-08-01',
        },
      ],
    },
  );
  const oldGuidance = await upload(
    'Management outlook',
    'Management maintained annual revenue guidance at USD 90 million to USD 100 million.',
  );
  const boundary = new Date().toISOString();
  await delay(10);
  const newGuidance = await upload(
    'Management outlook',
    'Management reduced annual revenue guidance to USD 70 million to USD 80 million after customers deferred orders. This replaces the previous forecast.',
  );
  await upload(
    'Other issuer liquidity',
    'Unrestricted cash covers five years of operations.',
    { symbol: 'OTHER' },
  );
  await search.startIndex('M4EVAL', randomUUID());
  await search.close();
  const status = await search.status('M4EVAL');
  assert.equal(status.job.status, 'completed', status.job.error);
  assert.equal(status.coverage.pending, 0);
  assert.equal(
    (await service.tool('research_find_company_v1', { query: 'M4EVAL' }))[0]
      .symbol,
    'M4EVAL',
  );
  process.stdout.write(
    `Index ready: ${status.coverage.indexed} current passages; provider ${provider.id}.\n`,
  );
  const cases = [
    [
      'Can the business fund itself for another twelve months?',
      'Liquidity and funding',
    ],
    [
      'How vulnerable is manufacturing to losing a supplier?',
      'Supply resilience',
    ],
    [
      'Are sales dependent on a small number of buyers?',
      'Customer concentration',
    ],
    ['Why is each sale generating less profit?', 'Unit economics'],
    ['What repayments are due soon?', 'Debt maturity'],
    ['Could existing ownership be watered down?', 'Equity issuance'],
    [
      'Has management become less optimistic about next year’s sales?',
      'Management outlook',
    ],
    [
      'What happens if the biggest buyer does not renew?',
      'Customer concentration',
    ],
  ];
  for (const [query, expected] of cases) {
    const keyword = await search.search({
      symbol: 'M4EVAL',
      query,
      mode: 'keyword',
    });
    const started = performance.now(),
      result = await search.search({ symbol: 'M4EVAL', query, mode: 'hybrid' });
    assert(result.hits.every((hit) => hit.symbol === 'M4EVAL'));
    assert(result.hits.every((hit) => hit.document_id !== oldGuidance));
    const titles = result.hits.map((hit) => docs.get(hit.document_id));
    report.queries.push({
      query,
      expected,
      top: titles.slice(0, 3),
      keywordTop: keyword.hits
        .slice(0, 3)
        .map((hit) => docs.get(hit.document_id)),
      rank: titles.indexOf(expected) + 1 || null,
      milliseconds: Math.round(performance.now() - started),
    });
    process.stdout.write(
      `Question ${report.queries.length}/${cases.length}: expected source rank ${titles.indexOf(expected) + 1 || 'missing'}.\n`,
    );
  }
  report.metrics = {
    questions: cases.length,
    top1: report.queries.filter((row) => row.rank === 1).length,
    top3: report.queries.filter((row) => row.rank && row.rank <= 3).length,
    keywordTop1: report.queries.filter(
      (row) => row.keywordTop[0] === row.expected,
    ).length,
  };
  const usageBefore = await db.researchSearch.dailyUsage();
  const cached = await search.search({
    symbol: 'M4EVAL',
    query: cases[0][0],
    mode: 'hybrid',
  });
  assert.equal(cached.embedding.cached, true);
  assert.deepEqual(await db.researchSearch.dailyUsage(), usageBefore);
  report.checks.cacheReuse = true;
  const historic = await service.tool(
    'research_search_evidence_v2',
    { symbol: 'M4EVAL', query: 'management guidance', mode: 'hybrid' },
    boundary,
  );
  assert(historic.hits.some((hit) => hit.document_id === oldGuidance));
  assert(historic.hits.every((hit) => hit.document_id !== newGuidance));
  report.checks.historicalIsolation = true;
  assert.equal(
    (
      await search.search({
        symbol: 'M4EVAL',
        query: '12345678.90123456789',
        mode: 'keyword',
      })
    ).hits[0].document_id,
    exact,
  );
  const facts = await service.tool('research_query_facts_v2', {
    symbol: 'M4EVAL',
    metric: 'Revenue',
    unit: 'USD',
    periodTo: '2026-06-30',
  });
  assert.equal(facts.facts[0].value, '12345678.90123456789');
  report.checks.exactDecimals = true;
  const irrelevant = await search.search({
    symbol: 'M4EVAL',
    query: 'How do I bake a sourdough loaf?',
    mode: 'hybrid',
  });
  report.checks.irrelevantQueryHits = irrelevant.hits.length;
  const api = await app.inject({
    method: 'POST',
    url: '/api/v1/research/search',
    payload: {
      version: 2,
      symbol: 'M4EVAL',
      query: cases[0][0],
      mode: 'hybrid',
    },
  });
  assert.equal(api.statusCode, 200);
  assert.deepEqual(api.json().data.hits, cached.hits);
  report.checks.sharedHttpAndAgentSearch = true;
  const answer = await agentQuestion(
    'Can the business fund itself for another twelve months? Answer briefly using the stored evidence and cite the relevant passage.',
  );
  assert(
    answer.answer.includes(`/research?document=${liquidity}`),
    'Agent must cite the retrieved liquidity source.',
  );
  assert(
    /six|6/i.test(answer.answer),
    'Agent must use the recorded six-month funding horizon.',
  );
  report.checks.citedAgentAnswer = true;
  // A fresh conversation prevents a previous answer from satisfying abstention.
  await db.chat.reset('research');
  const unknown = await agentQuestion(
    'What is the chief executive’s date of birth? Use stored evidence only. If the evidence does not provide it, say NO_SIGNAL and identify what is missing.',
  );
  assert(/NO_SIGNAL/i.test(unknown.answer));
  report.checks.agentAbstains = true;
  assert.equal((await db.portfolio.overview()).revision, 0);
  report.checks.financialStateUnchanged = true;
  if (live) {
    assert(
      report.metrics.top1 >= 6,
      'Live top-1 retrieval must pass at least 6 of 8 predeclared questions.',
    );
    assert.equal(
      report.metrics.top3,
      8,
      'Every expected source must be in the top three.',
    );
    assert.equal(
      irrelevant.hits.length,
      0,
      'Unrelated cooking query must not return financial evidence.',
    );
  }
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
  const path = `.tmp/company-search-${live ? 'live' : 'fixture'}-report.json`;
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
