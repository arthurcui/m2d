import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/db/dist/index.js';
import { migrateDatabase } from '../packages/db/dist/migrate.js';
import {
  IbkrMcpMarketDataProvider,
  MassiveBasicProvider,
} from '../packages/market/dist/index.js';
import {
  IbkrConnection,
  ibkrFileStore,
} from '../packages/market/dist/ibkr-connection.js';
import { readConfig } from '../packages/config/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { createMarketService } from '../apps/api/dist/market.js';
const ibkr = process.argv.includes('--ibkr');
if (
  !process.argv.includes('--live') ||
  process.argv.slice(2).some((a) => !['--live', '--ibkr'].includes(a))
)
  throw new Error('Explicit --live is required.');
if (
  !process.env.TEST_DATABASE_URL ||
  (!ibkr && !process.env.MASSIVE_API_KEY?.trim())
)
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
  if (++requests > (ibkr ? 24 : 3))
    throw new Error('Live request ceiling exceeded.');
  return globalThis.fetch(...args);
};
try {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(target.toString());
  const massive = new MassiveBasicProvider(
    process.env.MASSIVE_API_KEY,
    () => db.market.waitForMassiveRequest(),
    transport,
  );
  const connection = ibkr
    ? new IbkrConnection(
        ibkrFileStore(
          process.env.IBKR_CREDENTIAL_PATH ?? 'data/credentials/ibkr.json',
        ),
        new URL(
          '/api/ibkr/callback',
          process.env.PUBLIC_APP_URL ?? 'http://127.0.0.1:3000',
        ).toString(),
        () => db.market.waitForIbkrRequest(),
        transport,
      )
    : null;
  await connection?.load();
  const provider = connection
    ? new IbkrMcpMarketDataProvider(
        () => connection.open(),
        () => connection.connected,
      )
    : massive;
  const service = createMarketService(db.market, db.portfolio, provider, 'USD');
  const config = readConfig({
    ...process.env,
    DATABASE_URL: target.toString(),
    LLM_PROVIDER: 'fixture',
    LLM_MODEL: 'fixture-v1',
    MARKET_PROVIDER: provider.id,
  });
  app = buildApp(db.repository, config, false, db.portfolio, undefined, {
    repository: db.market,
    provider,
    service,
  });
  const before = (await db.portfolio.overview()).revision;
  const resolved = await db.market.refresh(
    randomUUID(),
    { kind: 'resolution', symbol: 'NVDA' },
    provider,
  );
  assert.equal(
    resolved.status,
    'SUCCEEDED',
    resolved.errorCode ?? resolved.status,
  );
  const resolution = (
    await app.inject('/api/v1/market/resolutions/NVDA')
  ).json().data.payload.value;
  assert.equal(resolution.candidates.length, 1);
  const choice = resolution.candidates[0];
  const result = await db.market.refresh(
    randomUUID(),
    {
      kind: 'bars',
      symbol: 'NVDA',
      exchange: choice.exchange,
      listingId: choice.id,
    },
    provider,
  );
  assert.equal(result.status, 'SUCCEEDED', result.errorCode ?? result.status);
  const response = await app.inject(
    `/api/v1/market/bars/NVDA?exchange=${choice.exchange}&listingId=${encodeURIComponent(choice.id)}`,
  );
  assert.equal(response.statusCode, 200);
  const stored = response.json().data;
  const bars = stored.payload.value;
  assert.ok(bars.length > 0 && bars.length <= 100);
  assert.ok(
    bars.every(
      (b) =>
        b.provider === provider.id &&
        b.exchange === choice.exchange &&
        (ibkr
          ? ['UNKNOWN', 'DELAYED'].includes(b.quality)
          : b.quality === 'DELAYED'),
    ),
  );
  const historical = await app.inject(
    `/api/v1/market/bars/NVDA?exchange=${choice.exchange}&listingId=${encodeURIComponent(choice.id)}&at=2020-01-01T00:00:00Z`,
  );
  assert.equal(historical.json().data, null);
  assert.equal((await db.portfolio.overview()).revision, before);
  const report = {
    passed: true,
    provider: provider.id,
    resolvedListing: choice,
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
    `.tmp/company-charts-${provider.id}-live.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app?.close();
  await db.close();
  await admin.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.close();
}
