import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import { MassiveBasicProvider } from '../packages/market/dist/index.js';
import { readConfig } from '../packages/config/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { createMarketService } from '../apps/api/dist/market.js';
if (process.argv.slice(2).join(' ') !== '--live')
  throw new Error('Explicit --live is required.');
if (!process.env.TEST_DATABASE_URL || !process.env.MASSIVE_API_KEY?.trim())
  throw new Error(
    'Disposable TEST_DATABASE_URL and configured MASSIVE_API_KEY required.',
  );
const admin = createDatabase(process.env.TEST_DATABASE_URL);
const name = `m2d_chart_live_${randomUUID().replaceAll('-', '')}`;
const target = new URL(process.env.TEST_DATABASE_URL);
target.pathname = `/${name}`;
const db = createDatabase(target.toString());
let requests = 0,
  app;
const transport = async (...args) => {
  if (++requests > 2) throw new Error('Two-request live ceiling exceeded.');
  return globalThis.fetch(...args);
};
try {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(target.toString());
  const provider = new MassiveBasicProvider(
    process.env.MASSIVE_API_KEY,
    () => db.market.waitForMassiveRequest(),
    transport,
  );
  const service = createMarketService(db.market, db.portfolio, provider, 'USD');
  const config = readConfig({
    ...process.env,
    DATABASE_URL: target.toString(),
    LLM_PROVIDER: 'fixture',
    LLM_MODEL: 'fixture-v1',
    MARKET_PROVIDER: 'massive',
  });
  app = buildApp(db.repository, config, false, db.portfolio, undefined, {
    repository: db.market,
    provider,
    service,
  });
  const before = (await db.portfolio.overview()).revision;
  const result = await db.market.refresh(
    randomUUID(),
    { kind: 'bars', symbol: 'NVDA', exchange: 'NASDAQ' },
    provider,
  );
  assert.equal(result.status, 'SUCCEEDED', result.errorCode ?? result.status);
  const response = await app.inject('/api/v1/market/bars/NVDA?exchange=NASDAQ');
  assert.equal(response.statusCode, 200);
  const stored = response.json().data;
  const bars = stored.payload.value;
  assert.ok(bars.length > 0 && bars.length <= 100);
  assert.ok(
    bars.every(
      (b) =>
        b.provider === 'massive' &&
        b.quality === 'DELAYED' &&
        b.adjustment === 'NONE',
    ),
  );
  const historical = await app.inject(
    '/api/v1/market/bars/NVDA?exchange=NASDAQ&at=2020-01-01T00:00:00Z',
  );
  assert.equal(historical.json().data, null);
  assert.equal((await db.portfolio.overview()).revision, before);
  const report = {
    passed: true,
    provider: 'massive',
    symbol: 'NVDA',
    requests,
    points: bars.length,
    first: bars[0].asOf,
    last: bars.at(-1).asOf,
    quality: bars[0].quality,
    adjustment: bars[0].adjustment,
    historicalCutoff: true,
    portfolioUnchanged: true,
    inferenceCalls: 0,
  };
  await mkdir('.tmp', { recursive: true });
  await writeFile(
    '.tmp/company-charts-live.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app?.close();
  await db.close();
  await admin.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.close();
}
