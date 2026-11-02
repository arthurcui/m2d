import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import {
  FixtureResearchProvider,
  type Source,
} from '../packages/research/dist/index.js';
import { ChatFixtureProvider } from '../packages/llm/dist/index.js';
import { createResearchService } from '../apps/api/src/research.js';
import { createResearchSearchService } from '../apps/api/src/research-search.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL must be a disposable pgvector/PostgreSQL database.',
  );
const admin = createDatabase(url),
  name = `m2d_search_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString()),
  provider = new ChatFixtureProvider(),
  search = createResearchSearchService(db.researchSearch, provider, {
    dailyBytes: 1000000,
    dailyBudget: null,
  }),
  service = createResearchService(
    db.research,
    new FixtureResearchProvider(),
    search,
  ),
  app = buildApp(
    db.repository,
    readConfig({ DATABASE_URL: target.toString() }),
    false,
    db.portfolio,
    { chat: db.chat, research: service },
  );
async function upload(
  text: string,
  key = 'report.txt',
  symbol = 'ACME',
  publishedAt: string | null = '2026-01-01T00:00:00Z',
) {
  const source: Source = {
    key,
    title: key,
    form: 'REPORT',
    url: null,
    publishedAt,
    raw: Buffer.from(text),
    mime: 'text/plain',
  };
  const id = randomUUID();
  await service.start({ idempotencyKey: id, symbol, upload: source });
  await service.close();
  const status = await db.research.import(id);
  expect(status.status, status.error).toBe('completed');
  return status.document_ids[0]!;
}
beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(target.toString());
  await migrateDatabase(target.toString());
});
afterAll(async () => {
  await app.close();
  await db.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
});
it('embeds identical extracted passages only once across revisions in the same batch', async () => {
  const text = 'Cash reserves support ongoing operations.';
  await upload(text, 'same.txt', 'REUSE');
  await upload(text + '\n', 'same.txt', 'REUSE');
  const before = await db.researchSearch.dailyUsage();
  await search.startIndex('REUSE', randomUUID());
  await search.close();
  const after = await db.researchSearch.dailyUsage();
  expect(after.inputBytes - before.inputBytes).toBe(
    Buffer.byteLength(`REUSE | REPORT | same.txt\n${text}`),
  );
  expect(
    await db.researchSearch.coverage(
      { symbol: 'REUSE', revisions: 'all' },
      search.profile,
    ),
  ).toEqual({ total: 2, indexed: 2, pending: 0 });
});
it('shares filtered evidence retrieval with the API and Advisor; caches queries and idempotent indexes', async () => {
  const liquidity = await upload(
      'Existing liquidity supports six months of operations. Management is seeking additional funding.',
    ),
    revenue = await upload(
      'Revenue increased to 123.450000000000000001 USD. Annual outlook was maintained.',
      'sales.txt',
    );
  await upload('Another company has abundant cash.', 'unrelated.txt', 'OTHER');
  const empty = await search.search({
    symbol: 'ACME',
    query: 'Could it run out of money?',
    mode: 'keyword',
  });
  expect(empty.hits).toHaveLength(0);
  await expect(
    search.search({ symbol: 'ACME', query: 'money', mode: 'hybrid' }),
  ).rejects.toMatchObject({ code: 'SEMANTIC_INDEX_REQUIRED' });
  const id = randomUUID();
  await search.startIndex('ACME', id);
  await search.close();
  expect((await db.researchSearch.job(id)).status).toBe('completed');
  const usage = await db.researchSearch.dailyUsage();
  await search.startIndex('ACME', id);
  await search.close();
  expect(await db.researchSearch.dailyUsage()).toEqual(usage);
  await expect(search.startIndex('OTHER', id)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const query = {
    symbol: 'ACME',
    query: 'Could it run out of money?',
    mode: 'hybrid' as const,
  };
  const result = (await service.tool(
    'research_search_evidence_v2',
    query,
  )) as Awaited<ReturnType<typeof search.search>>;
  expect(result.hits[0]?.document_id).toBe(liquidity);
  expect(result.hits.every((h) => h.symbol === 'ACME')).toBe(true);
  expect(result.hits[0]?.matches).toEqual(['semantic']);
  expect(result.warnings.join(' ')).toContain('Synthetic');
  const currentUsage = await db.researchSearch.dailyUsage();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/research/search',
    payload: { ...query, version: 2 },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.hits).toEqual(result.hits);
  expect(response.json().data.embedding.cached).toBe(true);
  expect(await db.researchSearch.dailyUsage()).toEqual(currentUsage);
  const exact = await search.search({
    symbol: 'ACME',
    query: '123.450000000000000001',
    mode: 'keyword',
  });
  expect(exact.hits[0]?.document_id).toBe(revenue);
  expect(exact.hits[0]?.text).toContain('123.450000000000000001');
  const context = (await service.tool('research_read_passage_v1', {
    documentId: liquidity,
    chunkIndex: 0,
  })) as { passages: unknown[] };
  expect(context.passages).toHaveLength(1);
  expect((await db.researchSearch.companies('ACME'))[0]?.symbol).toBe('ACME');
  expect(
    await db.researchSearch.companies('ACME', '2020-01-01T00:00:00Z'),
  ).toEqual([]);
});
it('selects revisions at the requested availability boundary, isolates filters and signals incomplete coverage', async () => {
  const original = await upload(
    'Debt refinancing risk remains elevated.',
    'revision.txt',
    'HISTORY',
  );
  const boundary = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 10));
  const revision = await upload(
    'Debt refinancing risk has declined after a new credit facility.',
    'revision.txt',
    'HISTORY',
  );
  await search.startIndex('HISTORY', randomUUID());
  await search.close();
  expect(
    (
      await search.search({ symbol: 'HISTORY', query: 'debt', mode: 'hybrid' })
    ).hits.map((h) => h.document_id),
  ).toEqual([revision]);
  const old = (await service.tool(
    'research_search_evidence_v2',
    {
      symbol: 'HISTORY',
      query: 'debt',
      mode: 'hybrid',
      at: '2099-01-01T00:00:00Z',
    },
    boundary,
  )) as Awaited<ReturnType<typeof search.search>>;
  expect(old.hits.map((h) => h.document_id)).toEqual([original]);
  expect(
    (
      await search.search({
        symbol: 'HISTORY',
        query: 'debt',
        mode: 'keyword',
        revisions: 'all',
      })
    ).hits,
  ).toHaveLength(2);
  expect(
    (
      await search.search({
        symbol: 'HISTORY',
        query: 'debt',
        mode: 'hybrid',
        source: 'sec',
      })
    ).hits,
  ).toHaveLength(0);
  expect(
    (
      await search.search({
        symbol: 'HISTORY',
        query: 'debt',
        mode: 'hybrid',
        forms: ['10-K'],
      })
    ).hits,
  ).toHaveLength(0);
  expect(
    (
      await search.search({
        symbol: 'HISTORY',
        query: 'debt',
        mode: 'keyword',
        publishedFrom: '2026-02-01',
      })
    ).hits,
  ).toHaveLength(0);
  await upload(
    'Debt outstanding is unchanged.',
    'undated.txt',
    'HISTORY',
    null,
  );
  const partial = await search.search({
    symbol: 'HISTORY',
    query: 'debt',
    mode: 'hybrid',
  });
  expect(partial.coverage.pending).toBe(1);
  expect(partial.warnings.join()).toContain('partial');
  expect(
    (
      await search.search({
        symbol: 'HISTORY',
        query: 'debt',
        mode: 'keyword',
        publishedTo: '2026-01-01',
      })
    ).hits.map((h) => h.document_id),
  ).toEqual([revision]);
  await expect(
    db.researchSearch.passage(revision, 0, boundary),
  ).rejects.toMatchObject({ code: 'PASSAGE_NOT_FOUND' });
});
it('filters exact financial values by period and unit without future-revision leakage', async () => {
  const id = randomUUID();
  await service.start({ idempotencyKey: id, symbol: 'FACTS' });
  await service.close();
  const facts = (await service.tool('research_query_facts_v2', {
    symbol: 'FACTS',
    metric: 'Revenue',
    unit: 'USD',
    periodFrom: '2026-04-01',
    periodTo: '2026-06-30',
  })) as { facts: { value: string }[]; truncated: boolean };
  expect(facts.facts).toHaveLength(1);
  expect(facts.facts[0]?.value).toBe('120000000');
  expect(facts.truncated).toBe(false);
  expect(
    (
      (await service.tool(
        'research_query_facts_v2',
        { symbol: 'FACTS' },
        '2020-01-01T00:00:00Z',
      )) as { facts: unknown[] }
    ).facts,
  ).toHaveLength(0);
});
it('enforces durable input-byte and cost ceilings before dispatching embeddings', async () => {
  const usage = await db.researchSearch.dailyUsage(),
    limited = createResearchSearchService(db.researchSearch, provider, {
      dailyBytes: usage.inputBytes,
      dailyBudget: null,
    });
  await expect(
    limited.search({
      symbol: 'ACME',
      query: 'Does funding run out next month?',
      mode: 'semantic',
    }),
  ).rejects.toMatchObject({ code: 'EMBEDDING_DAILY_LIMIT' });
  expect(await db.researchSearch.dailyUsage()).toEqual(usage);
  await expect(
    db.researchSearch.reserve({
      id: randomUUID(),
      profile: 'test',
      purpose: 'query',
      bytes: 1,
      dailyBytes: 1000000,
      cost: '1',
      priceVersion: 'test',
      dailyBudget: '0.5',
    }),
  ).rejects.toMatchObject({ code: 'DAILY_COST_LIMIT' });
  const before = await db.portfolio.overview();
  expect(before.revision).toBe(0);
});
it('retains uncertain request usage, surfaces provider failures and reuses completed work on retry', async () => {
  await upload('Cash reserves fund operations.', 'failure.txt', 'FAILURE');
  const failing = new ChatFixtureProvider();
  failing.embed = async () => {
    throw new Error('Offline simulated connection loss');
  };
  const failed = createResearchSearchService(db.researchSearch, failing, {
    dailyBytes: 1000000,
    dailyBudget: null,
  });
  const id = randomUUID();
  await failed.startIndex('FAILURE', id);
  await failed.close();
  expect((await db.researchSearch.job(id)).status).toBe('failed');
  expect((await db.researchSearch.dailyUsage()).uncertain).toBe(1);
  await search.startIndex('FAILURE', randomUUID());
  await search.close();
  expect((await search.status('FAILURE')).coverage.pending).toBe(0);
  await expect(
    failed.search({
      symbol: 'FAILURE',
      query: 'Is liquidity sufficient?',
      mode: 'hybrid',
    }),
  ).rejects.toThrow('Offline simulated connection loss');
  expect((await db.researchSearch.dailyUsage()).uncertain).toBe(2);
  await db.researchSearch.startJob(randomUUID(), 'FAILURE', search.profile);
  await db.researchSearch.recover();
  expect((await search.status('FAILURE')).job?.status).toBe('interrupted');
});
