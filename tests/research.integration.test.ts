import { createResearchSearchService } from '../apps/api/src/research-search.js';
import { ChatFixtureProvider } from '../packages/llm/dist/index.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import { FixtureResearchProvider } from '../packages/research/dist/index.js';
import { createResearchService } from '../apps/api/src/research.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error('TEST_DATABASE_URL must point to disposable PostgreSQL.');
const admin = createDatabase(url),
  name = `m2d_research_test_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString()),
  provider = new FixtureResearchProvider(),
  service = createResearchService(
    db.research,
    provider,
    createResearchSearchService(db.researchSearch, new ChatFixtureProvider(), {
      dailyBytes: 1000000,
      dailyBudget: null,
    }),
  );
const app = buildApp(
  db.repository,
  readConfig({ DATABASE_URL: target.toString() }),
  false,
  db.portfolio,
  { chat: db.chat, research: service },
);
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
it('persists explicit company choices idempotently without deleting research or holdings', async () => {
  const portfolio = await db.portfolio.overview();
  await service.start({
    idempotencyKey: randomUUID(),
    symbol: 'CHOICE',
  });
  await service.close();
  const docs = await db.research.timeline('CHOICE');
  for (const hidden of [true, true, false]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/research/companies/selection',
      payload: { version: 1, symbol: 'CHOICE', hidden },
    });
    expect(response.statusCode, response.body).toBe(200);
    const overview = (await app.inject('/api/v1/research')).json().data;
    expect(
      overview.companyChoices.filter(
        (c: { symbol: string }) => c.symbol === 'CHOICE',
      ),
    ).toEqual([{ symbol: 'CHOICE', hidden }]);
    expect(await db.research.timeline('CHOICE')).toEqual(docs);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/research/companies/selection',
        payload: { version: 1, symbol: 'invalid symbol', hidden: true },
      })
    ).statusCode,
  ).toBe(400);
  expect(await db.portfolio.overview()).toEqual(portfolio);
});
it('imports, deduplicates, searches, compares, cites and preserves the recorded portfolio', async () => {
  const id = randomUUID(),
    input = { version: 1, symbol: 'DEMO', idempotencyKey: id };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/research/import',
        payload: input,
      })
    ).statusCode,
  ).toBe(202);
  await service.close();
  const status = await db.research.import(id);
  expect(status.status, status.error).toBe('completed');
  const timelineResponse = await app.inject('/api/v1/research/companies/DEMO');
  expect(timelineResponse.statusCode, timelineResponse.body).toBe(200);
  expect(timelineResponse.json().data.facts).toHaveLength(2);
  const docs = await db.research.timeline('DEMO');
  expect(docs).toHaveLength(2);
  await service.start(input);
  await service.close();
  expect(await db.research.timeline('DEMO')).toHaveLength(2);
  await expect(
    service.start({ ...input, symbol: 'OTHER' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const hits = await db.research.search('DEMO', 'concentration');
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].text).toContain('concentration');
  const comparison = await service.compare(docs[1]!.id, docs[0]!.id);
  expect(comparison.removed.length).toBeGreaterThan(0);
  expect(comparison.added.length).toBeGreaterThan(0);
  const document = await db.research.document(docs[0]!.id);
  expect(document.findings.length).toBeGreaterThan(0);
  for (const finding of document.findings)
    expect(document.chunks[finding.chunk_index]!.text).toContain(finding.claim);
  const raw = await app.inject(`/api/v1/research/documents/${docs[0]!.id}/raw`);
  expect(raw.headers['content-disposition']).toContain('attachment');
  expect(raw.body).toContain('SYNTHETIC');
  expect((await db.portfolio.overview()).revision).toBe(0);
});
it('retains old versions and raw bytes, and enforces historical availability for tools and APIs', async () => {
  const source = (await provider.fetch('VERSION')).sources[0]!;
  await service.start({
    idempotencyKey: randomUUID(),
    symbol: 'VERSION',
    upload: {
      ...source,
      key: 'report.txt',
      title: 'report.txt',
      publishedAt: null,
    },
  });
  await service.close();
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await service.start({
    idempotencyKey: randomUUID(),
    symbol: 'VERSION',
    upload: {
      ...source,
      key: 'report.txt',
      title: 'report.txt',
      publishedAt: null,
      raw: Buffer.from(
        'Revenue guidance revised downward. Customer concentration remains a serious risk.',
      ),
    },
  });
  await service.close();
  const current = await db.research.timeline('VERSION');
  expect(current).toHaveLength(2);
  expect(current.map((d) => d.revision)).toEqual([2, 1]);
  expect(await db.research.timeline('VERSION', cutoff)).toHaveLength(1);
  expect(await db.research.raw(current[1]!.id)).toMatchObject({
    data: source.raw,
  });
  await expect(
    db.research.document(current[0]!.id, cutoff),
  ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_AVAILABLE' });
  expect(
    await service.tool(
      'research_search_documents_v1',
      { symbol: 'VERSION', query: 'downward', at: '2099-01-01T00:00:00Z' },
      cutoff,
    ),
  ).toEqual([]);
});
it('fails malformed uploads without replacing good research and recovers interrupted imports', async () => {
  const before = await db.research.timeline('DEMO');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/research/upload',
        payload: {
          version: 1,
          idempotencyKey: randomUUID(),
          symbol: 'DEMO',
          name: 'bad.exe',
          contentBase64: 'eHl6',
        },
      })
    ).statusCode,
  ).toBe(400);
  const id = randomUUID();
  await service.start({
    idempotencyKey: id,
    symbol: 'DEMO',
    upload: {
      key: 'empty.txt',
      title: 'Empty',
      form: 'UPLOAD',
      url: null,
      publishedAt: null,
      raw: Buffer.alloc(0),
      mime: 'text/plain',
    },
  });
  await service.close();
  expect((await db.research.import(id)).status).toBe('failed');
  expect(await db.research.timeline('DEMO')).toHaveLength(before.length);
  const interrupted = randomUUID();
  await db.research.begin(interrupted, 'DEMO', 'fixture', 'test');
  await db.research.recover();
  expect((await db.research.import(interrupted)).status).toBe('interrupted');
});

it('answers a selected-company research question through the real chat orchestration with retrieved citations', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/sessions/research/runs',
    payload: {
      version: 1,
      idempotencyKey: randomUUID(),
      message: 'Review the stored research and cite the evidence.',
      researchContext: { symbol: 'DEMO' },
    },
  });
  expect(r.statusCode, r.body).toBe(202);
  const id = r.json().data.id as string;
  for (let i = 0; i < 100; i++) {
    const run = await db.chat.getRun(id);
    if (run.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = await db.chat.getRun(id);
  expect(run.status).toBe('completed');
  const session = await db.chat.session('research');
  expect(JSON.stringify(session)).toContain('Synthetic fixture research.');
  expect(JSON.stringify(session)).toContain('/research?document=');
  expect((await db.portfolio.overview()).revision).toBe(0);
});
it('reports durable new/reused outcomes, deduplicates renamed uploads and preserves revisions and pasted metadata', async () => {
  const before = (await db.portfolio.overview()).revision;
  const base = {
    version: 1,
    symbol: 'PASTE',
    name: 'note.txt',
    title: 'Company note',
    sourceUrl: 'https://example.com/report',
    publishedAt: '2026-01-01T00:00:00Z',
    contentBase64: Buffer.from(
      'Revenue outlook is improving. Customer concentration remains a material risk.',
    ).toString('base64'),
  };
  async function send(input: typeof base, id = randomUUID()) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/research/upload',
      payload: { ...input, idempotencyKey: id },
    });
    expect(response.statusCode, response.body).toBe(202);
    await service.close();
    return await db.research.import(id);
  }
  const id = randomUUID(),
    first = await send(base, id);
  expect(first).toMatchObject({
    status: 'completed',
    added_count: 1,
    reused_count: 0,
  });
  expect(first.passage_count).toBeGreaterThan(0);
  expect((await send(base, id)).document_ids).toEqual(first.document_ids);
  const duplicate = await send({ ...base, name: 'renamed.txt' });
  expect(duplicate).toMatchObject({ added_count: 0, reused_count: 1 });
  expect(duplicate.document_ids).toEqual(first.document_ids);
  const changed = await send({
    ...base,
    contentBase64: Buffer.from(
      'Revenue guidance is lower. Customer concentration risk increased.',
    ).toString('base64'),
  });
  expect(changed).toMatchObject({ added_count: 1, reused_count: 0 });
  const docs = await db.research.timeline('PASTE');
  expect(docs).toHaveLength(2);
  expect(docs.map((d) => d.revision)).toEqual([2, 1]);
  expect(docs[1]).toMatchObject({ title: 'Company note', url: base.sourceUrl });
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/research/upload',
    payload: {
      ...base,
      sourceUrl: 'javascript:alert(1)',
      idempotencyKey: randomUUID(),
    },
  });
  expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
  await expect(
    db.pool.query('update research_imports set reused_count=-1 where id=$1', [
      id,
    ]),
  ).rejects.toThrow();
  expect((await db.portfolio.overview()).revision).toBe(before);
});

it('records A to B to A as three immutable revisions and reuses only current content', async () => {
  const original = (await provider.fetch('REVERT')).sources[0]!;
  const ids: string[] = [],
    cutoffs: string[] = [];
  for (const text of [
    'Outlook is strong.',
    'Outlook is weak.',
    'Outlook is strong.',
    'Outlook is strong.',
  ]) {
    const id = randomUUID();
    await db.research.begin(id, 'REVERT', 'upload', randomUUID());
    ids.push(
      (
        await db.research.commit(
          id,
          'REVERT',
          'Reversion test',
          null,
          'upload',
          [
            {
              ...original,
              key: 'report.txt',
              url: null,
              publishedAt: null,
              raw: Buffer.from(text),
              chunks: [{ index: 0, page: null, text }],
            },
          ],
        )
      )[0]!,
    );
    cutoffs.push(new Date().toISOString());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(new Set(ids).size).toBe(3);
  expect(ids[3]).toBe(ids[2]);
  const timeline = await db.research.timeline('REVERT');
  expect(timeline.map((d) => d.revision)).toEqual([3, 2, 1]);
  expect(timeline[0]!.hash).toBe(timeline[2]!.hash);
  for (let i = 0; i < 3; i++) {
    const rows = await db.researchSearch.lexical({
      symbol: 'REVERT',
      query: 'outlook',
      at: cutoffs[i],
      revisions: 'latest',
    });
    expect(rows.map((r) => r.document_id)).toEqual([ids[i]]);
  }
  const latest = await db.researchSearch.lexical({
    symbol: 'REVERT',
    query: 'outlook',
    revisions: 'latest',
  });
  expect(latest[0]!.text).toBe('Outlook is strong.');
});
