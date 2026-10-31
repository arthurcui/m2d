import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
import { systemStatusSchema } from '../packages/domain/src/index.js';
const config = readConfig({
  DATABASE_URL: 'postgres://test:test@localhost/test',
});
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function appFor(failing = false, lastHeartbeat: Date | null = new Date()) {
  const app = buildApp(
    {
      checkReady: async () => {
        if (failing) throw new Error('secret-password');
      },
      getState: async () => ({ lastHeartbeat, lastDemoJob: lastHeartbeat }),
    },
    config,
  );
  apps.push(app);
  return app;
}
describe('HTTP v1 operational contracts', () => {
  it('separates liveness from readiness and sanitizes dependency failures', async () => {
    const app = appFor(true);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    for (const path of ['/health', '/health/ready', '/api/v1/health/ready']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('secret-password');
      expect(response.json().error.code).toBe('DATABASE_NOT_READY');
    }
  });
  it('returns a validated status with UTC observations, no financial data, and no inference', async () => {
    const response = await appFor().inject('/api/v1/system/status');
    expect(response.statusCode).toBe(200);
    const status = systemStatusSchema.parse(response.json());
    expect(status.data.worker.status).toBe('online');
    expect(status.data.ai.available).toBe(false);
    expect(status.data.worker.scheduler).toBe('healthy');
    expect(response.body).not.toContain('DATABASE_URL');
  });
  it('reports missing/stale worker separately from database readiness', async () => {
    const app = appFor(false, null);
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    expect(
      (await app.inject('/api/v1/system/status')).json().data.worker,
    ).toMatchObject({
      status: 'stale',
      scheduler: 'waiting',
      lastHeartbeat: null,
    });
    const stale = appFor(false, new Date('2020-01-01T00:00:00Z'));
    expect(
      (await stale.inject('/api/v1/system/status')).json().data.worker
        .scheduler,
    ).toBe('stale');
  });
  it('returns explicit degraded status and rejects future mutation routes', async () => {
    const app = appFor(true);
    const response = await app.inject('/api/v1/system/status');
    expect(response.statusCode).toBe(503);
    expect(systemStatusSchema.parse(response.json()).data.worker.status).toBe(
      'unavailable',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/portfolio/changes/confirm',
        })
      ).statusCode,
    ).toBe(404);
  });
});
