import { readConfig } from '@m2d/config';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@m2d/db';
import { buildApp } from './app.js';
import { createMarketService } from './market.js';
import {
  FixtureMarketProvider,
  TwelveDataProvider,
  MassiveBasicProvider,
  IbkrMcpMarketDataProvider,
} from '@m2d/market';
import { IbkrConnection, ibkrFileStore } from '@m2d/market/ibkr-connection';

const config = readConfig(process.env);
const database = createDatabase(config.DATABASE_URL);
const ibkr = new IbkrConnection(
  ibkrFileStore(
    process.env.IBKR_CREDENTIAL_PATH ??
      fileURLToPath(
        new URL('../../../data/credentials/ibkr.json', import.meta.url),
      ),
  ),
  new URL('/api/ibkr/callback', config.PUBLIC_APP_URL).toString(),
  () => database.market.waitForIbkrRequest(),
);
await ibkr.load();
const marketProvider =
  config.MARKET_PROVIDER === 'fixture'
    ? new FixtureMarketProvider()
    : config.MARKET_PROVIDER === 'ibkr'
      ? new IbkrMcpMarketDataProvider(
          () => ibkr.open(),
          () => ibkr.connected,
        )
      : config.MARKET_PROVIDER === 'massive'
        ? new MassiveBasicProvider(process.env.MASSIVE_API_KEY ?? '', () =>
            database.market.waitForMassiveRequest(),
          )
        : new TwelveDataProvider(
            process.env.TWELVE_DATA_API_KEY ?? '',
            config.MARKET_DELAY_MINUTES,
          );
const listingProvider =
  config.LISTING_PROVIDER === 'fixture'
    ? new FixtureMarketProvider()
    : config.LISTING_PROVIDER === 'massive'
      ? new MassiveBasicProvider(process.env.MASSIVE_API_KEY ?? '', () =>
          database.market.waitForMassiveRequest(),
        )
      : undefined;
const app = buildApp(
  database.repository,
  config,
  true,
  database.portfolio,
  {
    key: process.env.OPENAI_API_KEY ?? '',
    chat: database.chat,
  },
  {
    repository: database.market,
    ibkr,
    provider: marketProvider,
    listingProvider,
    service: createMarketService(
      database.market,
      database.portfolio,
      marketProvider,
      config.BASE_CURRENCY,
      listingProvider,
    ),
  },
);
app.addHook('onClose', async () => database.close());
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void shutdown();
  });
try {
  await database.chat.recover();
  await database.market.recover();
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch {
  console.error(
    'API startup failed; check configuration and port availability.',
  );
  await shutdown();
  process.exitCode = 1;
}
