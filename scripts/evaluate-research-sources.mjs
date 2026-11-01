import process from 'node:process';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import { readConfig } from '../packages/config/dist/index.js';
import {
  ChatFixtureProvider,
  OpenAiProvider,
} from '../packages/llm/dist/index.js';
import {
  FixtureResearchProvider,
  PublicResearchSources,
  sourcePresets,
} from '../packages/research/dist/index.js';
import { createResearchService } from '../apps/api/dist/research.js';
import { createResearchSearchService } from '../apps/api/dist/research-search.js';
import { buildApp } from '../apps/api/dist/app.js';

// Explicit opt-in; isolated databases only. No portfolio information is read or sent.
const live = process.argv.includes('--live');
const analyst = process.argv.includes('--analyst');
const scope = analyst ? 'NVDA' : 'TSLL';
if (process.argv.slice(2).some((arg) => !['--live', '--analyst'].includes(arg)))
  throw new Error('Only --live is supported.');
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error('Set TEST_DATABASE_URL to disposable PostgreSQL/pgvector.');
const key = process.env.OPENAI_API_KEY?.trim() ?? '',
  newsKey = process.env.MASSIVE_API_KEY?.trim() ?? '';
if (live && (!key || process.env.LLM_PROVIDER !== 'openai'))
  throw new Error(
    'Live evaluation requires the configured backend OpenAI provider/key.',
  );
const baseline = readConfig({ ...process.env, DATABASE_URL: url });
const cap = (value) =>
  value !== undefined && Number(value) < 0.25 ? value : '0.25';
const config = {
  ...baseline,
  LLM_PROVIDER: live ? 'openai' : 'fixture',
  LLM_MODEL: live ? baseline.LLM_MODEL : 'fixture-v1',
  LLM_MAX_STEPS: Math.min(baseline.LLM_MAX_STEPS, 5),
  LLM_MAX_TOOL_CALLS: Math.min(baseline.LLM_MAX_TOOL_CALLS, 4),
  LLM_MAX_OUTPUT_TOKENS: Math.min(baseline.LLM_MAX_OUTPUT_TOKENS, 1024),
  LLM_RUN_TIMEOUT_MS: Math.min(baseline.LLM_RUN_TIMEOUT_MS, 45000),
  LLM_REQUEST_TIMEOUT_MS: Math.min(baseline.LLM_REQUEST_TIMEOUT_MS, 20000),
  LLM_MAX_RUN_COST_USD: cap(baseline.LLM_MAX_RUN_COST_USD),
  LLM_DAILY_BUDGET_USD: cap(baseline.LLM_DAILY_BUDGET_USD),
};
config.LLM_INPUT_USD_PER_MILLION ??= baseline.LLM_MODEL.startsWith(
  'gpt-5.4-mini',
)
  ? '0.75'
  : undefined;
config.LLM_OUTPUT_USD_PER_MILLION ??= baseline.LLM_MODEL.startsWith(
  'gpt-5.4-mini',
)
  ? '4.50'
  : undefined;
config.LLM_PRICE_VERSION ??= 'openai-gpt-5.4-mini-2026-10-31';
const llm = live ? new OpenAiProvider(key) : new ChatFixtureProvider();
const admin = createDatabase(url),
  name = `m2d_source_eval_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString());
config.DATABASE_URL = target.toString();
const search = createResearchSearchService(db.researchSearch, llm, {
  dailyBytes: Math.min(baseline.RESEARCH_EMBEDDING_DAILY_BYTES, 20000),
  dailyBudget: config.LLM_DAILY_BUDGET_USD,
});
const sources = new PublicResearchSources(live ? 'live' : 'fixture', newsKey),
  service = createResearchService(
    db.research,
    new FixtureResearchProvider(),
    search,
    sources,
  );
const app = buildApp(db.repository, config, false, db.portfolio, {
  chat: db.chat,
  research: service,
  key: live ? key : '',
});
const presets = sourcePresets('TSLA', sources.newsConfigured);
let selected = [
  'tesla-q3-2026',
  'fed-calendar',
  'bls-calendar',
  'fed-policy',
  'bls-cpi',
  'bls-jobs',
  'occ-notices',
  'massive-news',
].map((id) => presets.find((p) => p.id === id));
selected.push({
  ...sourcePresets('TSLL', false).find((p) => p.id === 'direxion-tsla'),
  url: 'https://www.direxion.com/uploads/TSLL-TSLS-Fact-Sheet.pdf',
  name: 'Direxion TSLL/TSLS fact sheet',
});
selected.push(sourcePresets('NVDA', false).find((p) => p.id === 'nvidia-ir'));
if (analyst)
  selected = [
    {
      id: 'goldman-article',
      symbol: scope,
      kind: 'analyst',
      name: 'Goldman Sachs public AI research',
      url: 'https://www.goldmansachs.com/insights/articles/competition-among-chinas-ai-models-is-intensifying-as-chip-sector-advances',
      configured: true,
    },
  ];
const report = {
  at: new Date().toISOString(),
  mode: live ? 'live' : 'fixture',
  sources: [],
  checks: {},
  passed: false,
};
let created = false;
try {
  await admin.pool.query(`create database "${name}"`);
  created = true;
  await migrateDatabase(target.toString());
  const portfolio = await db.portfolio.overview();
  for (const preset of selected) {
    const { symbol, kind, name: sourceName, url: sourceUrl } = preset;
    if (preset.configured === false) {
      report.sources.push({ id: preset.id, status: 'unconfigured' });
      continue;
    }
    const id = randomUUID();
    await service.start({
      idempotencyKey: id,
      symbol,
      link: { symbol, kind, name: sourceName, url: sourceUrl },
      news: preset.id === 'massive-news',
    });
    await service.close();
    const job = await db.research.import(id);
    if (job.status !== 'completed') {
      report.sources.push({
        id: preset.id,
        status: job.status,
        error: job.error,
      });
      continue;
    }
    let passages = 0;
    for (const documentId of job.document_ids) {
      const doc = await db.research.document(documentId),
        original = await db.research.raw(documentId);
      assert.equal(
        createHash('sha256').update(original.data).digest('hex'),
        doc.hash,
      );
      assert.equal(doc.provider, live ? kind : 'fixture');
      assert(new Date(doc.available_at) >= new Date(doc.observed_at));
      passages += doc.chunks.length;
    }
    assert(passages > 0);
    report.sources.push({
      id: preset.id,
      status: 'completed',
      documents: job.document_ids.length,
      passages,
      originalHashesVerified: true,
    });
  }
  for (const id of analyst
    ? ['goldman-article']
    : [
        'tesla-q3-2026',
        'fed-calendar',
        'bls-calendar',
        'fed-policy',
        'bls-cpi',
        'bls-jobs',
        'direxion-tsla',
      ])
    assert(
      report.sources.some((s) => s.id === id && s.status === 'completed'),
      `Required public source failed: ${id}`,
    );
  const job = await search.startIndex(scope, randomUUID());
  await search.close();
  const status = await search.repository.job(job.id);
  assert.equal(status.status, 'completed', status.error);
  const query = analyst
    ? 'What does the report say about competition among Chinese AI models? Does it supply an NVDA price target, currency and horizon? Mark absent fields unknown.'
    : live
      ? 'Why can holding TSLL longer than one day produce a result different from two times Teslaâ€™s return?'
      : 'What is the revenue outlook?';
  const evidence = await search.search({
    symbol: scope,
    query,
    mode: 'hybrid',
    limit: 5,
  });
  assert(evidence.hits.length > 0);
  assert(
    evidence.hits.every(
      (hit) =>
        hit.citation &&
        hit.provider === (live ? (analyst ? 'analyst' : 'fund') : 'fixture'),
    ),
  );
  report.checks.sharedHybridSearch = true;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/research/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      analysisMode: 'standard',
      researchContext: { symbol: scope },
      message: query + ' Cite the stored evidence and explain the main risks.',
    },
  });
  assert.equal(response.statusCode, 202, response.body);
  let run;
  for (let i = 0; i < 260; i++) {
    run = await db.chat.getRun(response.json().data.id);
    if (run.status !== 'running') break;
    await delay(200);
  }
  const session = await db.chat.session('research');
  const answer =
    session.history.findLast(
      (item) => item.kind === 'text' && item.role === 'assistant',
    )?.text ?? '';
  report.agent = {
    status: run.status,
    error: run.error,
    answer,
    usage: run.usage,
  };
  assert.equal(run.status, 'completed');
  assert.match(answer, /\/research\?document=/);
  assert.equal(run.previewId, null);
  report.checks.citedAgentAnswer = true;
  assert.deepEqual(await db.portfolio.overview(), portfolio);
  report.checks.portfolioUnchanged = true;
  report.passed = true;
} catch (error) {
  report.failure = {
    code: error.code ?? 'EVALUATION_FAILED',
    message: [key, newsKey]
      .filter(Boolean)
      .reduce(
        (text, secret) => text.replaceAll(secret, '[REDACTED]'),
        String(error.message),
      ),
  };
  process.exitCode = 1;
} finally {
  await app.close();
  if (created) report.embeddingUsage = await db.researchSearch.dailyUsage();
  await db.close();
  if (created) await admin.pool.query(`drop database "${name}"`);
  await admin.close();
  await mkdir('.tmp', { recursive: true });
  const path = `.tmp/research-${analyst ? 'analyst' : 'sources'}-${live ? 'live' : 'fixture'}-report.json`;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    path.replace('-report.json', `-${report.at.replaceAll(':', '-')}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      sources: report.sources,
      checks: report.checks,
      failure: report.failure,
      report: path,
    }) + '\n',
  );
}
