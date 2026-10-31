import Fastify, { LogController } from 'fastify';
import { aiStatus, type Config } from '@m2d/config';
import { type SystemRepository } from '@m2d/db';
import {
  DEMO_STALE_MS,
  HEARTBEAT_STALE_MS,
  freshness,
  systemStatusSchema,
} from '@m2d/domain';

export function buildApp(
  repository: SystemRepository,
  config: Config,
  logger = false,
) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const meta = () => ({
    version: 1 as const,
    asOf: new Date().toISOString(),
    source: 'm2d-system' as const,
    dataQuality: 'OPERATIONAL' as const,
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
      meta: meta(),
    }),
  );
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'This route is not available in M0.',
      },
      meta: meta(),
    }),
  );
  for (const prefix of ['', '/api/v1']) {
    app.get(`${prefix}/health/live`, async () => ({
      data: { status: 'alive' },
      meta: meta(),
    }));
    for (const path of ['/health', '/health/ready']) {
      app.get(`${prefix}${path}`, async (_request, reply) => {
        try {
          await repository.checkReady();
          return { data: { status: 'ready' }, meta: meta() };
        } catch {
          return reply.code(503).send({
            error: {
              code: 'DATABASE_NOT_READY',
              message: 'Database unavailable or migrations incomplete.',
            },
            meta: meta(),
          });
        }
      });
    }
  }
  app.get('/api/v1/system/status', async (_request, reply) => {
    let database: 'ready' | 'unavailable' = 'ready';
    let state = {
      lastHeartbeat: null as Date | null,
      lastDemoJob: null as Date | null,
    };
    try {
      await repository.checkReady();
      state = await repository.getState();
    } catch {
      database = 'unavailable';
      reply.code(503);
    }
    const now = new Date();
    return systemStatusSchema.parse({
      data: {
        milestone: 'M0',
        database,
        worker: {
          status:
            database === 'unavailable'
              ? 'unavailable'
              : freshness(state.lastHeartbeat, now, HEARTBEAT_STALE_MS)
                ? 'online'
                : 'stale',
          lastHeartbeat: state.lastHeartbeat?.toISOString() ?? null,
          lastDemoJob: state.lastDemoJob?.toISOString() ?? null,
          scheduler:
            database === 'unavailable'
              ? 'unavailable'
              : !state.lastDemoJob
                ? 'waiting'
                : freshness(state.lastDemoJob, now, DEMO_STALE_MS)
                  ? 'healthy'
                  : 'stale',
        },
        ai: aiStatus(config),
        market: { provider: 'fixture', status: 'not_implemented' },
        displayTimezone: config.APP_TIMEZONE,
        marketTimezone: config.MARKET_TIMEZONE,
      },
      meta: meta(),
    });
  });
  return app;
}
