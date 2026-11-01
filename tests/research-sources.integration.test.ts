import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import {
  FixtureResearchProvider,
  PublicResearchSources,
  ResearchError,
  type SourceLink,
} from '../packages/research/dist/index.js';
import { ChatFixtureProvider } from '../packages/llm/dist/index.js';
import { createResearchService } from '../apps/api/src/research.js';
import { createResearchSearchService } from '../apps/api/src/research-search.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error('TEST_DATABASE_URL must point to disposable PostgreSQL.');
const admin = createDatabase(url),
  name = `m2d_sources_${randomUUID().replaceAll('-', '')}`,
  target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString());
let content =
    'Issuer revenue outlook improved. Customer concentration remains a material risk.',
  fail = false;
const search = createResearchSearchService(
  db.researchSearch,
  new ChatFixtureProvider(),
  { dailyBytes: 1000000, dailyBudget: null },
);
const service = createResearchService(
  db.research,
  new FixtureResearchProvider(),
  search,
  new PublicResearchSources('live', '', async (url) => {
    if (fail)
      throw new ResearchError('SOURCE_UNAVAILABLE', 'Test source unavailable.');
    return { url, mime: 'text/plain', raw: Buffer.from(content) };
  }),
);
const app = buildApp(
  db.repository,
  readConfig({ DATABASE_URL: target.toString() }),
  false,
  db.portfolio,
  { chat: db.chat, research: service },
);
const post = (path: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/research/sources${path}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const link: SourceLink = {
  symbol: 'SOURCES',
  kind: 'ir',
  name: 'Company releases',
  url: 'https://issuer.example/releases',
};
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
it('saves links idempotently, imports immutable revisions, filters evidence, and preserves portfolio state', async () => {
  const before = await db.portfolio.overview();
  const saved = await post('', { version: 1, ...link });
  expect(saved.statusCode, saved.body).toBe(200);
  const again = await post('', { version: 1, ...link, name: 'Renamed source' });
  expect(again.json().data.id).toBe(saved.json().data.id);
  const catalog = await app.inject('/api/v1/research/sources?symbol=SOURCES');
  expect(catalog.json().data.saved).toHaveLength(1);
  const input = {
    version: 1,
    symbol: link.symbol,
    link,
    idempotencyKey: randomUUID(),
  };
  expect((await post('/import', input)).statusCode).toBe(202);
  await service.close();
  expect((await db.research.import(input.idempotencyKey)).status).toBe(
    'completed',
  );
  const original = (await db.research.timeline(link.symbol))[0]!;
  expect(original.provider).toBe('ir');
  expect(
    Buffer.from((await db.research.raw(original.id)).data).toString(),
  ).toBe(content);
  expect(new Date(original.available_at).getTime()).toBeGreaterThanOrEqual(
    new Date(original.observed_at).getTime(),
  );
  await post('/import', input);
  await service.close();
  expect(await db.research.timeline(link.symbol)).toHaveLength(1);
  expect(
    (
      await post('/import', {
        ...input,
        link: { ...link, name: 'Different request' },
      })
    ).statusCode,
  ).toBe(409);
  const result = await search.search({
    symbol: link.symbol,
    query: 'revenue outlook',
    source: 'ir',
    mode: 'keyword',
    limit: 5,
  });
  expect(result.hits.length).toBeGreaterThan(0);
  expect(
    (
      await search.search({
        symbol: link.symbol,
        query: 'revenue outlook',
        source: 'macro',
        mode: 'keyword',
        limit: 5,
      })
    ).hits,
  ).toHaveLength(0);
  content =
    'Issuer revenue outlook weakened. Customer concentration remains a material risk.';
  await post('/import', { ...input, idempotencyKey: randomUUID() });
  await service.close();
  expect(await db.research.timeline(link.symbol)).toHaveLength(2);
  expect(
    Buffer.from((await db.research.raw(original.id)).data).toString(),
  ).toContain('improved');
  const failure = randomUUID();
  fail = true;
  await post('/import', { ...input, idempotencyKey: failure });
  await service.close();
  fail = false;
  expect((await db.research.import(failure)).status).toBe('failed');
  expect(await db.research.timeline(link.symbol)).toHaveLength(2);
  await post('/remove', { version: 1, id: saved.json().data.id });
  await post('/remove', { version: 1, id: saved.json().data.id });
  expect(await db.research.sourceLinks(link.symbol)).toHaveLength(0);
  expect(await db.research.timeline(link.symbol)).toHaveLength(2);
  expect(await db.portfolio.overview()).toEqual(before);
});
it('validates source ownership, credentials, origin and missing provider configuration', async () => {
  expect(
    (await post('', { version: 1, ...link, url: 'https://localhost/private' }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await post('/import', {
        version: 1,
        symbol: 'OTHER',
        link,
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post('/import', {
        version: 1,
        symbol: 'SOURCES',
        preset: 'massive-news',
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
  ).toBe(503);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/research/sources',
        headers: { origin: 'https://evil.example' },
        payload: { version: 1, ...link },
      })
    ).statusCode,
  ).toBe(403);
});
it('keeps pre-extension request fingerprints replayable', async () => {
  const id = randomUUID(),
    symbol = 'LEGACY';
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ symbol, provider: 'fixture', upload: null }))
    .digest('hex');
  await db.research.begin(id, symbol, 'fixture', fingerprint);
  await db.research.failed(id, 'Recorded before extension.');
  await expect(
    service.start({ symbol, idempotencyKey: id }),
  ).resolves.toMatchObject({ status: 'failed' });
});
