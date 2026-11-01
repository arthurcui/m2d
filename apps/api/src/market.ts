import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { instrumentKey, currency } from '@m2d/portfolio';
import {
  marketRequestSchema,
  marketSubject,
  type MarketRepository,
  type PortfolioRepository,
  type MarketRequest,
} from '@m2d/db';
import {
  equitySession,
  qualityAt,
  valuePortfolio,
  symbolSchema,
  type MarketProvider,
  type Quote,
  type Fx,
} from '@m2d/market';

export function createMarketService(
  repository: MarketRepository,
  portfolio: PortfolioRepository,
  provider: MarketProvider,
  baseCurrency: string,
) {
  return {
    async valuation() {
      const overview = await portfolio.overview();
      const requests: MarketRequest[] = [];
      for (const p of overview.state.positions.filter(
        (p) => p.quantity !== '0',
      ))
        requests.push(
          p.instrument.assetType === 'OPTION' && provider.id !== 'massive'
            ? {
                kind: 'options',
                symbol: p.instrument.underlying!,
                expiry: p.instrument.expiry!,
              }
            : { kind: 'quote', instrument: p.instrument },
        );
      const currencies = new Set([
        ...overview.state.cash
          .filter((c) => c.balance !== '0')
          .map((c) => c.currency),
        ...overview.state.positions
          .filter((p) => p.quantity !== '0')
          .map((p) => p.instrument.currency),
      ]);
      for (const c of currencies)
        if (c !== baseCurrency)
          requests.push({ kind: 'fx', base: c, quote: baseCurrency });
      const unique = [
        ...new Map(
          requests.map((r) => [`${r.kind}:${marketSubject(r)}`, r]),
        ).values(),
      ];
      const quotes: Quote[] = [],
        fx: Fx[] = [],
        observationIds: string[] = [];
      for (const r of unique) {
        const row = await repository.read(
          provider.id,
          r.kind,
          marketSubject(r),
        );
        if (!row) continue;
        observationIds.push(row.id);
        if (row.payload.kind === 'quote') quotes.push(row.payload.value);
        if (row.payload.kind === 'options')
          quotes.push(...row.payload.value.map((o) => o.quote));
        if (row.payload.kind === 'fx') fx.push(row.payload.value);
      }
      return {
        ...valuePortfolio(
          overview.state,
          quotes,
          fx,
          baseCurrency,
          new Date().toISOString(),
        ),
        portfolioRevision: overview.revision,
        observationIds,
        requests: unique,
        provider: provider.id,
        refreshIntervalMs: provider.id === 'twelvedata' ? 8100 : 0,
      };
    },
    async status() {
      return {
        provider: provider.id,
        configured: provider.configured,
        session: equitySession(new Date().toISOString()),
        calendar: 'NYSE equities 2026–2027',
        options:
          provider.id === 'fixture'
            ? 'Limited synthetic examples; Greeks unavailable'
            : provider.id === 'massive'
              ? 'Basic: individual option end-of-day closes via portfolio refresh; no chain snapshots, bid/ask or Greeks.'
              : 'Unavailable in this adapter',
        description:
          provider.id === 'massive'
            ? provider.configured
              ? 'Massive Basic · end-of-day data, not live quotes. Cached completed-day prices; requests are paced to the free allowance. Each new holding may take about 30 seconds.'
              : 'Set MASSIVE_API_KEY in the backend .env and MARKET_PROVIDER=massive. Basic supplies end-of-day data, not live quotes.'
            : provider.id === 'fixture'
              ? 'Offline synthetic examples. These are not real market prices.'
              : provider.configured
                ? 'Configured provider. Refreshes use your data plan; allow 8 seconds between requests.'
                : 'Set TWELVE_DATA_API_KEY in the backend environment to enable market requests.',
        refreshes: await repository.status(provider.id),
      };
    },
  };
}
export type MarketService = ReturnType<typeof createMarketService>;
export async function marketRoutes(
  app: FastifyInstance,
  opts: {
    repository: MarketRepository;
    provider: MarketProvider;
    service: MarketService;
  },
) {
  const { repository, provider, service } = opts;
  const envelope = (data: unknown) => ({
    data,
    meta: { version: 1, asOf: new Date().toISOString(), source: provider.id },
  });
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET') return;
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' || origin)
      return reply.code(403).send({
        error: {
          code: 'ORIGIN_REJECTED',
          message: 'Cross-origin market refresh rejected.',
        },
      });
  });
  app.get('/api/v1/market/status', async () =>
    envelope(await service.status()),
  );
  app.get('/api/v1/portfolio/valuation', async () =>
    envelope(await service.valuation()),
  );
  app.get('/api/v1/market/snapshots', async () =>
    envelope(await repository.snapshots(provider.id)),
  );
  app.post('/api/v1/market/snapshots', async (req) => {
    const { idempotencyKey } = z
      .object({ version: z.literal(1), idempotencyKey: z.uuid() })
      .strict()
      .parse(req.body);
    const value = await service.valuation();
    return envelope(
      await repository.saveSnapshot(
        idempotencyKey,
        value.portfolioRevision,
        provider.id,
        value,
        value.observationIds,
      ),
    );
  });
  app.post('/api/v1/market/refresh', async (req) => {
    const input = z
      .object({
        version: z.literal(1),
        idempotencyKey: z.uuid(),
        request: marketRequestSchema,
      })
      .strict()
      .parse(req.body);
    return envelope(
      await repository.refresh(input.idempotencyKey, input.request, provider),
    );
  });
  app.get('/api/v1/market/quotes', async (req) => {
    const input = z
      .object({
        symbol: symbolSchema,
        assetType: z.enum(['STOCK', 'ETF']).default('STOCK'),
        exchange: z
          .string()
          .regex(/^[A-Z0-9.-]{1,20}$/)
          .default('NASDAQ'),
        currency: currency.default('USD'),
      })
      .parse(req.query);
    const instrument = {
      ...input,
      optionRight: null,
      expiry: null,
      strike: null,
      multiplier: '1',
      underlying: null,
      deliverable: null,
    };
    const row = await repository.read(
      provider.id,
      'quote',
      instrumentKey(instrument),
    );
    return envelope(
      row?.payload.kind === 'quote'
        ? {
            ...row,
            quality: qualityAt(row.payload.value, new Date().toISOString()),
          }
        : null,
    );
  });
  app.get('/api/v1/market/bars/:ticker', async (req) => {
    const { ticker } = z.object({ ticker: symbolSchema }).parse(req.params);
    const { exchange } = z
      .object({
        exchange: z.enum(['NASDAQ', 'NYSE', 'AMEX', 'ARCA']).default('NASDAQ'),
      })
      .parse(req.query);
    return envelope(
      await repository.read(provider.id, 'bars', `${ticker}:${exchange}`),
    );
  });
  app.get('/api/v1/market/options/:ticker', async (req) => {
    const { ticker } = z.object({ ticker: symbolSchema }).parse(req.params);
    const { expiry } = z.object({ expiry: z.iso.date() }).parse(req.query);
    return envelope(
      await repository.read(provider.id, 'options', `${ticker}:${expiry}`),
    );
  });
  app.get('/api/v1/market/fx', async (req) => {
    const { base, quote } = z
      .object({ base: currency, quote: currency })
      .parse(req.query);
    return envelope(
      await repository.read(provider.id, 'fx', `${base}/${quote}`),
    );
  });
}
