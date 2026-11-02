import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PortfolioRepository, RiskRepository } from '@m2d/db';
import type { MarketService } from './market.js';
import {
  riskSummary,
  riskPolicySchema,
  type RiskPolicy,
  baseExposure,
  evaluateStrategy,
  evaluateStockTrade,
  validatePlan,
  planInputSchema,
  planDraftSchema,
  RiskError,
} from '@m2d/risk';
export function createRiskService(
  portfolio: PortfolioRepository,
  repository: RiskRepository,
  market?: MarketService,
  policy: RiskPolicy = riskPolicySchema.parse({}),
) {
  async function snapshot() {
    const p = await portfolio.overview(),
      v = market ? await market.valuation() : null;
    if (v && v.portfolioRevision !== p.revision)
      throw new RiskError(
        'STALE_PORTFOLIO',
        'Portfolio changed during analysis. Retry.',
        409,
      );
    return {
      p,
      v,
      quotes:
        v?.positions.flatMap((row) => (row.quote ? [row.quote] : [])) ?? [],
    };
  }
  return {
    repository,
    async summary() {
      const { p, v, quotes } = await snapshot();
      return {
        ...riskSummary(
          p.state,
          quotes,
          v?.optionSnapshots ?? [],
          new Date().toISOString(),
          policy,
        ),
        portfolioRevision: p.revision,
        baseValuation: v,
        baseExposure: v ? baseExposure(v) : null,
      };
    },
    async stock(raw: unknown) {
      return evaluateStockTrade((await portfolio.overview()).state, raw);
    },
    async evaluate(raw: unknown) {
      return evaluateStrategy(raw);
    },
    async plan(raw: unknown, save = false) {
      const input = planInputSchema.parse(raw);
      if (save) {
        const saved = await repository.replay(input);
        if (saved) return saved;
      }
      const { p, quotes } = await snapshot();
      if (p.revision !== input.portfolioRevision)
        throw new RiskError(
          'STALE_PORTFOLIO',
          'Review current portfolio before planning.',
          409,
        );
      const assessment = validatePlan(
        p.state,
        input,
        quotes,
        new Date().toISOString(),
        policy,
      );
      return {
        assessment,
        ...(save ? await repository.save(input, assessment) : {}),
      };
    },
    async tool(name: string, args: unknown) {
      if (name === 'risk_summary_read_v1') return this.summary();
      if (name === 'strategy_evaluate_v1') return this.evaluate(args);
      if (name === 'stock_trade_evaluate_v1') return this.stock(args);
      if (name === 'trade_plan_preview_v1')
        return this.plan({
          ...planDraftSchema.parse(args),
          idempotencyKey: randomUUID(),
          portfolioRevision: (await portfolio.overview()).revision,
        });
      throw new RiskError('UNKNOWN_RISK_TOOL', 'Unsupported risk tool.');
    },
  };
}
export type RiskService = ReturnType<typeof createRiskService>;
export async function riskRoutes(
  app: FastifyInstance,
  { service: s }: { service: RiskService },
) {
  const wrap = (data: unknown) => ({
    data,
    meta: { version: 1, asOf: new Date().toISOString(), source: 'm2d-risk' },
  });
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'POST' && req.headers.origin)
      return reply.code(403).send({
        error: {
          code: 'ORIGIN_REJECTED',
          message: 'Use the same-origin application proxy.',
        },
      });
  });
  app.get('/api/v1/risk/summary', async () => wrap(await s.summary()));
  app.post('/api/v1/risk/scenarios', async (req) => {
    z.object({ version: z.literal(1) })
      .strict()
      .parse(req.body);
    return wrap(await s.summary());
  });
  app.post('/api/v1/strategies/evaluate', async (req) =>
    wrap(await s.evaluate(req.body)),
  );
  app.post('/api/v1/risk/stock-trade', async (req) =>
    wrap(await s.stock(req.body)),
  );
  app.post('/api/v1/risk/plans/preview', async (req) =>
    wrap(await s.plan(req.body)),
  );
  app.post('/api/v1/risk/plans', async (req) =>
    wrap(await s.plan(req.body, true)),
  );
  app.get('/api/v1/risk/plans', async () => wrap(await s.repository.list()));
}
