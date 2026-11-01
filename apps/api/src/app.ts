import { chatRoutes } from './chat.js';
import { marketRoutes, type MarketService } from './market.js';
import { MarketError, type MarketProvider } from '@m2d/market';
import type { IbkrConnection } from '@m2d/market/ibkr-connection';
import type { MarketRepository } from '@m2d/db';
import type { ChatRepository } from '@m2d/db';
import { LlmError } from '@m2d/llm';
import Fastify, { LogController } from 'fastify';
import { z } from 'zod';
import { PortfolioError } from '@m2d/portfolio';
import { portfolioRoutes } from './portfolio.js';
import { createWorkbookAi } from './workbook-ai.js';
import type { LlmProvider } from '@m2d/llm';
import { aiStatus, type Config } from '@m2d/config';
import { type SystemRepository, type PortfolioRepository } from '@m2d/db';
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
  portfolio?: PortfolioRepository,
  aiOptions?: { key?: string; provider?: LlmProvider; chat?: ChatRepository },
  market?: {
    repository: MarketRepository;
    provider: MarketProvider;
    listingProvider?: MarketProvider | undefined;
    service: MarketService;
    ibkr?: IbkrConnection;
  },
) {
  const workbookAi = portfolio
    ? createWorkbookAi(portfolio, config, aiOptions?.key, aiOptions?.provider)
    : undefined;
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MarketError)
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message },
        meta: meta(),
      });
    if (error instanceof LlmError)
      return reply.code(400).send({
        error: { code: error.code, message: error.message },
        meta: meta(),
      });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Please correct the highlighted input.',
          details: error.issues,
        },
        meta: meta(),
      });
    if (error instanceof PortfolioError)
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        meta: meta(),
      });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        error: {
          code: 'INVALID_REQUEST',
          message:
            error.statusCode === 413
              ? 'Upload exceeds the 2 MiB limit.'
              : 'Malformed or unsupported request.',
        },
        meta: meta(),
      });
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
      meta: meta(),
    });
  });
  if (portfolio && workbookAi)
    app.register(portfolioRoutes, { repository: portfolio, workbookAi });
  if (market) app.register(marketRoutes, market);
  if (portfolio && aiOptions?.chat)
    app.register(chatRoutes, {
      repository: aiOptions.chat,
      portfolio,
      config,
      ...(market ? { market: market.service } : {}),
      ...(aiOptions.key ? { key: aiOptions.key } : {}),
      ...(aiOptions.provider ? { provider: aiOptions.provider } : {}),
    });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'This route is not available.',
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
        milestone: 'M3',
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
        ai: workbookAi?.status ?? aiStatus(config),
        market: {
          provider: config.MARKET_PROVIDER,
          status: market?.provider.configured
            ? config.MARKET_PROVIDER === 'fixture'
              ? 'fixture_only'
              : 'ready'
            : 'unconfigured',
        },
        displayTimezone: config.APP_TIMEZONE,
        marketTimezone: config.MARKET_TIMEZONE,
      },
      meta: meta(),
    });
  });
  return app;
}
