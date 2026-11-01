import { z } from 'zod';
import type { IbkrConnection } from '@m2d/market/ibkr-connection';
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
  listingLookup,
  listingKey,
  listingCacheMs,
  MarketError,
  type ListingOverview,
  type MarketProvider,
  type Quote,
  type Fx,
} from '@m2d/market';

export function createMarketService(
  repository: MarketRepository,
  portfolio: PortfolioRepository,
  provider: MarketProvider,
  baseCurrency: string,
  listingProvider?: MarketProvider,
) {
  return {
    async listings(): Promise<ListingOverview> {
      const value: ListingOverview = {
        provider: listingProvider?.id ?? 'none',
        configured: listingProvider?.configured ?? false,
        listings: {},
        requests: [],
      };
      if (!listingProvider) return value;
      const overview = await portfolio.overview();
      const unique = new Map(
        overview.state.positions
          .filter((p) => p.quantity !== '0')
          .map((p) => {
            const lookup = listingLookup(p.instrument);
            return [listingKey(lookup), lookup];
          }),
      );
      for (const [key, lookup] of unique) {
        const row = await repository.read(listingProvider.id, 'listing', key);
        if (row?.payload.kind === 'listing') {
          const v = row.payload.value;
          value.listings[key] = {
            id: row.id,
            lookup: v.lookup,
            name: v.name,
            exchange: v.exchange,
            assetType: v.assetType,
            provider: v.provider,
            asOf: v.asOf,
            logoIssue: v.logoIssue,
            logoUrl: v.logo ? `/api/v1/market/listings/${row.id}/logo` : null,
          };
        }
        if (
          !row ||
          row.payload.kind !== 'listing' ||
          Date.now() - Date.parse(row.availableAt) >=
            listingCacheMs(row.payload.value)
        )
          value.requests.push({ kind: 'listing', lookup });
      }
      return value;
    },
    async valuation() {
      const overview = await portfolio.overview();
      const requests: MarketRequest[] = [];
      for (const p of overview.state.positions.filter(
        (p) => p.quantity !== '0',
      ))
        requests.push(
          p.instrument.assetType === 'OPTION' &&
            !['massive', 'ibkr'].includes(provider.id)
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
              : provider.id === 'ibkr'
                ? 'Standard equity option snapshots; bounded near-spot sample of up to six contracts. Greeks unavailable.'
                : 'Unavailable in this adapter',
        description:
          provider.id === 'ibkr'
            ? 'IBKR hosted MCP · read-only market tools. Prices depend on market data subscriptions. Frozen/unknown data stays indicative; exact delay may be unavailable.'
            : provider.id === 'massive'
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
    listingProvider?: MarketProvider | undefined;
    service: MarketService;
    ibkr?: IbkrConnection;
  },
) {
  const { repository, provider, service } = opts;
  const envelope = (data: unknown, source: string = provider.id) => ({
    data,
    meta: { version: 1, asOf: new Date().toISOString(), source },
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
  app.get('/api/v1/portfolio/listings', async () =>
    envelope(await service.listings(), opts.listingProvider?.id ?? 'none'),
  );
  app.get('/api/v1/market/listings/:id/logo', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const logo = await repository.listingLogo(id);
    if (!logo)
      return reply.code(404).send({
        error: { code: 'NO_LOGO', message: 'Listing logo unavailable.' },
      });
    return reply
      .header('Content-Type', logo.mime)
      .header('Cache-Control', 'private, max-age=86400, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(Buffer.from(logo.base64, 'base64'));
  });
  app.get('/api/v1/market/status', async () =>
    envelope(await service.status()),
  );
  app.get('/api/v1/market/ibkr/status', async () =>
    envelope({
      ...(opts.ibkr?.status() ?? {
        connected: false,
        pending: false,
        scope: 'mcp.read',
        expiresAt: null,
      }),
      active: provider.id === 'ibkr',
      available: !!opts.ibkr,
    }),
  );
  app.post('/api/v1/market/ibkr/connect', async () => {
    if (!opts.ibkr) throw new Error('IBKR connection unavailable');
    return envelope(await opts.ibkr.start());
  });
  app.post('/api/v1/market/ibkr/callback', async (req) => {
    const input = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().min(1).max(4096),
        issuer: z.literal('https://api.ibkr.com'),
      })
      .strict()
      .parse(req.body);
    if (!opts.ibkr) throw new Error('IBKR connection unavailable');
    return envelope(
      await opts.ibkr.complete(input.state, input.code, input.issuer),
    );
  });
  app.post('/api/v1/market/ibkr/disconnect', async () => {
    if (!opts.ibkr) throw new Error('IBKR connection unavailable');
    return envelope(await opts.ibkr.disconnect());
  });
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
    const selected =
      input.request.kind === 'listing' ? opts.listingProvider : provider;
    if (!selected)
      throw new MarketError(
        'MARKET_NOT_CONFIGURED',
        'Listing details are not configured. Set LISTING_PROVIDER in the backend environment.',
        503,
      );
    return envelope(
      await repository.refresh(input.idempotencyKey, input.request, selected),
      selected.id,
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
