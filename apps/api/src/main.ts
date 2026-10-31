import { readConfig } from '@m2d/config';
import { createDatabase } from '@m2d/db';
import { buildApp } from './app.js';

const config = readConfig(process.env);
const database = createDatabase(config.DATABASE_URL);
const app = buildApp(database.repository, config, true, database.portfolio, {
  key: process.env.OPENAI_API_KEY ?? '',
  chat: database.chat,
});
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
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch {
  console.error(
    'API startup failed; check configuration and port availability.',
  );
  await shutdown();
  process.exitCode = 1;
}
