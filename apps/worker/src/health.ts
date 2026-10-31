import { createDatabase } from '@m2d/db';
import { freshness, HEARTBEAT_STALE_MS } from '@m2d/domain';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const database = createDatabase(url);
try {
  const state = await database.repository.getState();
  if (!freshness(state.lastHeartbeat, new Date(), HEARTBEAT_STALE_MS))
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await database.close();
}
