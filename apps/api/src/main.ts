import { readConfig } from '@m2d/config';
import { createDatabase } from '@m2d/db';
import { buildApp } from './app.js';
import { createMarketService } from './market.js';
import { FixtureMarketProvider, TwelveDataProvider } from '@m2d/market';

const config = readConfig(process.env);
const database = createDatabase(config.DATABASE_URL);
const marketProvider =
  config.MARKET_PROVIDER === 'fixture'
    ? new FixtureMarketProvider()
    : new TwelveDataProvider(
        process.env.TWELVE_DATA_API_KEY ?? '',
        config.MARKET_DELAY_MINUTES,
      );
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
    provider: marketProvider,
    service: createMarketService(
      database.market,
      database.portfolio,
      marketProvider,
      config.BASE_CURRENCY,
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
