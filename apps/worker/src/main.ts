import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { readConfig } from '@m2d/config';
import { createDatabase } from '@m2d/db';
import { DEMO_QUEUE } from '@m2d/domain';
import { handleDemoJob } from './jobs.js';

const config = readConfig(process.env);
const database = createDatabase(config.DATABASE_URL);
const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  application_name: 'm2d-worker',
});
const startedAt = new Date();
const instanceId = randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let heartbeatInFlight: Promise<void> = Promise.resolve();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await heartbeatInFlight;
  await boss.stop({ graceful: true, timeout: 10000 });
  await database.close();
}
// A broken queue must not keep advertising a healthy worker. Compose restarts it.
boss.on('error', () => {
  console.error('Worker queue unavailable; restarting is required.');
  process.exitCode = 1;
  void shutdown();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void shutdown();
  });
async function heartbeat() {
  if (stopping) return;
  try {
    await database.repository.heartbeat(instanceId, startedAt);
  } catch {
    console.error('Worker heartbeat failed; database unavailable.');
  }
  if (!stopping)
    timer = setTimeout(() => {
      heartbeatInFlight = heartbeat();
    }, 10000);
}
try {
  await database.repository.checkReady();
  await boss.start();
  await boss.createQueue(DEMO_QUEUE, {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 30,
  });
  await boss.work(DEMO_QUEUE, { pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      const inserted = await handleDemoJob(job, database.repository.recordDemo);
      console.log(
        JSON.stringify({
          event: 'demo_job_completed',
          jobId: job.id,
          inserted,
        }),
      );
    }
  });
  const payload = { version: 1 as const, kind: 'foundation-demo' as const };
  await boss.schedule(DEMO_QUEUE, '* * * * *', payload, { tz: 'UTC' });
  // Immediate startup probe, deduplicated within a minute; retries retain the job UUID.
  await boss.send(DEMO_QUEUE, payload, {
    singletonKey: 'startup',
    singletonSeconds: 60,
  });
  heartbeatInFlight = heartbeat();
  await heartbeatInFlight;
  console.log('Worker ready: offline demo scheduled every minute (UTC).');
} catch {
  console.error(
    'Worker startup failed; check migrations and database availability.',
  );
  process.exitCode = 1;
  await shutdown();
}
