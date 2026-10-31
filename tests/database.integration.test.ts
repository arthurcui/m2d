import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import { DEMO_QUEUE } from '../packages/domain/src/index.js';
import { handleDemoJob } from '../apps/worker/src/jobs.js';
import fixture from '../fixtures/foundation-demo.json' with { type: 'json' };

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable test database. No tests were skipped.',
  );
const database = createDatabase(url);
const boss = new PgBoss({ connectionString: url });
boss.on('error', () => {
  /* Assertions below expose queue failures without connection secrets. */
});
beforeAll(async () => {
  await migrateDatabase(url);
  await migrateDatabase(url);
});
afterAll(async () => {
  await boss.stop();
  await database.close();
});
describe('PostgreSQL and durable queue', () => {
  it('migrates idempotently and enforces SQL constraints and retry idempotence', async () => {
    await database.repository.checkReady();
    const jobId = randomUUID();
    expect(await database.repository.recordDemo(jobId)).toBe(true);
    expect(await database.repository.recordDemo(jobId)).toBe(false);
    const count = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM demo_job_runs WHERE job_id = $1',
      [jobId],
    );
    expect(count.rows[0]?.count).toBe('1');
    await expect(
      database.pool.query(
        "INSERT INTO demo_job_runs(job_id, queue, version) VALUES ($1, 'invalid', 2)",
        [randomUUID()],
      ),
    ).rejects.toThrow();
    const started = new Date();
    await database.repository.heartbeat(randomUUID(), started);
    expect((await database.repository.getState()).lastHeartbeat).toBeInstanceOf(
      Date,
    );
  });
  it('initializes pg-boss, upserts one schedule, and retries the same job without duplicating its effect', async () => {
    await boss.start();
    await boss.createQueue(DEMO_QUEUE, { retryLimit: 2, retryDelay: 1 });
    await boss.schedule(DEMO_QUEUE, '0 0 1 1 *', fixture, { tz: 'UTC' });
    await boss.schedule(DEMO_QUEUE, '0 0 1 1 *', fixture, { tz: 'UTC' });
    expect(
      (await boss.getSchedules()).filter(
        (schedule) => schedule.name === DEMO_QUEUE,
      ),
    ).toHaveLength(1);
    let calls = 0;
    const id = await boss.send(DEMO_QUEUE, fixture);
    expect(id).toBeTruthy();
    const results: boolean[] = [];
    await boss.work(
      DEMO_QUEUE,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          if (job.id !== id) continue;
          results.push(
            await handleDemoJob(job, database.repository.recordDemo),
          );
          calls += 1;
          if (calls === 1)
            throw new Error(
              'Simulated failure after DB write but before queue acknowledgement',
            );
        }
      },
    );
    await expect.poll(() => calls, { timeout: 15000 }).toBe(2);
    expect(results).toEqual([true, false]);
    const count = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM demo_job_runs WHERE job_id = $1',
      [id],
    );
    expect(count.rows[0]?.count).toBe('1');
  });
});
