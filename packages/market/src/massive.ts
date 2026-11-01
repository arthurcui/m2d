import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  instrumentSchema,
  positive,
  nonnegative,
  type Instrument,
} from '@m2d/portfolio';
import {
  MarketError,
  payloadSchema,
  type MarketProvider,
  type FeedResult,
  type Evidence,
} from './contracts.js';
import { equitySession } from './calendar.js';

const exchanges: Record<string, string> = {
  NASDAQ: 'XNAS',
  NYSE: 'XNYS',
  AMEX: 'XASE',
  ARCA: 'ARCX',
};
const numericFields = new Set([
  'open',
  'close',
  'high',
  'low',
  'volume',
  'o',
  'c',
  'h',
  'l',
  'v',
  'strike_price',
  'shares_per_contract',
]);
const aggregate = z.object({
  t: z.number().int().positive(),
  o: positive,
  h: positive,
  l: positive,
  c: positive,
  v: nonnegative.optional(),
});
const aggregates = z.object({
  status: z.literal('OK'),
  ticker: z.string(),
  adjusted: z.literal(false),
  results: z.array(aggregate).max(200).default([]),
});
const equityReference = z.object({
  status: z.literal('OK'),
  results: z.object({
    ticker: z.string(),
    market: z.literal('stocks'),
    locale: z.literal('us'),
    primary_exchange: z.string(),
    currency_name: z.string(),
    type: z.string(),
  }),
});
const optionReference = z.object({
  status: z.literal('OK'),
  results: z.object({
    ticker: z.string(),
    underlying_ticker: z.string(),
    expiration_date: z.string(),
    contract_type: z.enum(['call', 'put']),
    strike_price: positive,
    shares_per_contract: positive,
    additional_underlyings: z.array(z.unknown()).optional(),
    primary_exchange: z
      .string()
      .regex(/^[A-Z0-9.-]{1,20}$/)
      .optional(),
  }),
});
const closeResponse = z.object({
  status: z.literal('OK'),
  symbol: z.string(),
  from: z.string(),
  close: positive,
});

export function newYorkDate(epoch: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epoch));
}
// Basic publishes completed dates. Never query today's potentially paid data.
export function massiveCompletedDate(epoch: number) {
  const today = newYorkDate(epoch);
  for (let offset = 1; offset <= 10; offset++) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) - offset * 86400000)
      .toISOString()
      .slice(0, 10);
    const session = equitySession(`${date}T16:00:00Z`);
    if (session === 'UNKNOWN')
      throw new MarketError(
        'CALENDAR_UNAVAILABLE',
        'The exchange calendar does not cover this date.',
      );
    if (session === 'REGULAR') return date;
  }
  throw new MarketError(
    'NO_COVERAGE',
    'No completed trading date in the calendar.',
  );
}
function dayEnd(date: string) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(noon)),
  );
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + (24 + 12 - hour) * 3600000 - 1,
  ).toISOString();
}
export function massiveOptionTicker(input: Instrument) {
  const i = instrumentSchema.parse(input);
  if (
    i.assetType !== 'OPTION' ||
    i.currency !== 'USD' ||
    ![
      'UNKNOWN',
      'US',
      'OPRA',
      'CBOE',
      'NASDAQ',
      'NYSE',
      'AMEX',
      'ARCA',
    ].includes(i.exchange) ||
    !/^[A-Z]{1,6}$/.test(i.underlying!)
  )
    throw new MarketError(
      'UNSUPPORTED_INSTRUMENT',
      'Massive Basic supports standard US equity options in USD.',
    );
  const strike = new Decimal(i.strike!).mul(1000);
  if (!strike.isInteger() || strike.gt(99999999))
    throw new MarketError(
      'UNSUPPORTED_INSTRUMENT',
      'Option strike cannot be represented without rounding.',
    );
  return `O:${i.underlying}${i.expiry!.replaceAll('-', '').slice(2)}${i.optionRight === 'CALL' ? 'C' : 'P'}${strike.toFixed(0).padStart(8, '0')}`;
}

export class MassiveBasicProvider implements MarketProvider {
  id = 'massive' as const;
  configured: boolean;
  private nextCall = 0;
  constructor(
    private key: string,
    private beforeRequest: () => Promise<void>,
    private transport: typeof fetch = fetch,
    private clock = () => Date.now(),
    private sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.configured = !!key.trim();
  }

  private evidence(
    id: string,
    asOf: string,
    session: Evidence['session'],
  ): Evidence {
    const now = new Date(this.clock()).toISOString();
    return {
      provider: this.id,
      sourceRecordId: id,
      asOf,
      receivedAt: now,
      availableAt: now,
      session,
      delayedMinutes: null,
      quality: 'DELAYED',
      entitlement:
        'Massive Basic · end-of-day only · no live quotes, bid/ask or Greeks',
    };
  }
  private async request(path: string, params: Record<string, string> = {}) {
    if (!this.configured)
      throw new MarketError(
        'MARKET_NOT_CONFIGURED',
        'Set MASSIVE_API_KEY in the backend environment.',
        503,
      );
    // Local pacing complements the durable DB gate; both count every HTTP call.
    const wait = this.nextCall - this.clock();
    if (wait > 0) await this.sleep(wait);
    await this.beforeRequest();
    this.nextCall = this.clock() + 13000;
    const url = new URL(path, 'https://api.massive.com');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      const response = await this.transport(url, {
        headers: { Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new MarketError(
          response.status === 429
            ? 'MARKET_RATE_LIMIT'
            : [401, 403].includes(response.status)
              ? 'MARKET_ENTITLEMENT_REQUIRED'
              : response.status === 404
                ? 'NO_COVERAGE'
                : 'MARKET_PROVIDER_ERROR',
          'Massive request unavailable. Check the key, Basic data access and quota.',
          response.status === 429 ? 429 : 502,
        );
      const raw = await response.text();
      if (raw.length > 2_000_000)
        throw new MarketError(
          'INVALID_MARKET_DATA',
          'Provider response exceeded the supported size.',
          502,
        );
      const body: unknown = JSON.parse(
        raw,
        (key: string, value: unknown, context?: { source: string }) =>
          numericFields.has(key) && typeof value === 'number' && context?.source
            ? new Decimal(context.source).toFixed()
            : value,
      );
      return { raw, body };
    } catch (e) {
      if (e instanceof MarketError) throw e;
      throw new MarketError(
        'MARKET_UNAVAILABLE',
        'Massive could not return valid data. Stored evidence is unchanged.',
        503,
      );
    }
  }
  private async equity(
    symbol: string,
    exchange: string,
    date: string,
    assetType?: 'STOCK' | 'ETF',
  ) {
    if (!exchanges[exchange] && !['US', 'UNKNOWN'].includes(exchange))
      throw new MarketError(
        'UNSUPPORTED_EXCHANGE',
        'Massive Basic supports US-listed stocks and ETFs.',
      );
    const response = await this.request(
      `/v3/reference/tickers/${encodeURIComponent(symbol)}`,
      { date },
    );
    const parsed = equityReference.safeParse(response.body);
    if (
      !parsed.success ||
      parsed.data.results.ticker !== symbol ||
      parsed.data.results.currency_name.toUpperCase() !== 'USD' ||
      !(['US', 'UNKNOWN'].includes(exchange)
        ? Object.values(exchanges).includes(
            parsed.data.results.primary_exchange,
          )
        : parsed.data.results.primary_exchange === exchanges[exchange])
    )
      throw new MarketError(
        'INSTRUMENT_MISMATCH',
        'Massive reference data does not match the US instrument.',
        502,
      );
    if (
      (assetType === 'ETF' && parsed.data.results.type !== 'ETF') ||
      (assetType === 'STOCK' &&
        !['CS', 'ADRC'].includes(parsed.data.results.type))
    )
      throw new MarketError(
        'ASSET_CLASS_MISMATCH',
        'The provider security type conflicts with the recorded stock/ETF class.',
        502,
      );
    return {
      raw: response.raw,
      exchange: parsed.data.results.primary_exchange,
    };
  }
  async quote(input: Instrument): Promise<FeedResult> {
    const i = instrumentSchema.parse(input);
    if (i.currency !== 'USD')
      throw new MarketError(
        'UNSUPPORTED_INSTRUMENT',
        'Massive Basic supports USD-denominated US stocks, ETFs and options.',
      );
    const date = massiveCompletedDate(this.clock());
    let symbol = i.symbol,
      reference: string;
    let resolvedExchange: string | undefined;
    if (i.assetType === 'OPTION') {
      symbol = massiveOptionTicker(i);
      const response = await this.request(
        `/v3/reference/options/contracts/${encodeURIComponent(symbol)}`,
        { as_of: date },
      );
      const parsed = optionReference.safeParse(response.body);
      const r = parsed.success ? parsed.data.results : null;
      if (
        !r ||
        r.ticker !== symbol ||
        r.underlying_ticker !== i.underlying ||
        r.expiration_date !== i.expiry ||
        r.contract_type !== i.optionRight!.toLowerCase() ||
        !new Decimal(r.strike_price).eq(i.strike!) ||
        r.shares_per_contract !== '100' ||
        r.additional_underlyings?.length
      )
        throw new MarketError(
          'INSTRUMENT_MISMATCH',
          'Option contract terms do not match the recorded standard contract.',
          502,
        );
      reference = response.raw;
      resolvedExchange = r.primary_exchange;
    } else {
      const listing = await this.equity(symbol, i.exchange, date, i.assetType);
      reference = listing.raw;
      resolvedExchange = listing.exchange;
    }
    const response = await this.request(
      `/v1/open-close/${encodeURIComponent(symbol)}/${date}`,
      { adjusted: 'false' },
    );
    const parsed = closeResponse.safeParse(response.body);
    if (
      !parsed.success ||
      parsed.data.symbol !== symbol ||
      parsed.data.from !== date
    )
      throw new MarketError(
        'NO_COVERAGE',
        'No matching end-of-day close for the completed trading date.',
        502,
      );
    // asOf is the daily period end, not an invented last-trade timestamp.
    return {
      raw: { reference, close: response.raw },
      payload: payloadSchema.parse({
        kind: 'quote',
        value: {
          ...this.evidence(`${symbol}:${date}`, dayEnd(date), 'CLOSED'),
          instrument: i,
          ...(resolvedExchange ? { resolvedExchange } : {}),
          bid: null,
          ask: null,
          last: parsed.data.close,
          kind: 'EOD_CLOSE',
        },
      }),
    };
  }
  async bars(symbol: string, exchange = 'NASDAQ'): Promise<FeedResult> {
    const date = massiveCompletedDate(this.clock());
    const reference = await this.equity(symbol, exchange, date);
    const from = new Date(Date.parse(`${date}T12:00:00Z`) - 4 * 86400000)
      .toISOString()
      .slice(0, 10);
    const response = await this.request(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/hour/${from}/${date}`,
      { adjusted: 'false', sort: 'asc', limit: '5000' },
    );
    const parsed = aggregates.safeParse(response.body);
    if (!parsed.success || parsed.data.ticker !== symbol)
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'Massive hourly bars failed validation.',
        502,
      );
    const value = parsed.data.results
      .map((b) => {
        const start = new Date(b.t).toISOString(),
          end = new Date(b.t + 3600000).toISOString();
        if (
          newYorkDate(b.t) < from ||
          newYorkDate(b.t) > date ||
          Date.parse(end) > Date.parse(dayEnd(date)) + 1
        )
          throw new MarketError(
            'INVALID_MARKET_DATA',
            'Provider bars exceed the requested completed dates.',
            502,
          );
        const session = equitySession(start);
        return {
          ...this.evidence(
            `${symbol}:${start}`,
            end,
            session === equitySession(new Date(b.t + 3599999).toISOString())
              ? session
              : 'UNKNOWN',
          ),
          symbol,
          currency: 'USD',
          exchange,
          interval: '1h',
          start,
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v ?? null,
          adjustment: 'NONE',
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(-100);
    if (!value.length)
      throw new MarketError(
        'NO_COVERAGE',
        'No completed hourly bars returned.',
      );
    return {
      raw: { reference: reference.raw, bars: response.raw },
      payload: payloadSchema.parse({ kind: 'bars', value }),
    };
  }
  async options(_symbol: string, _expiry: string): Promise<FeedResult> {
    void _symbol;
    void _expiry;
    throw new MarketError(
      'OPTIONS_UNAVAILABLE',
      'Basic has no chain snapshots or Greeks. Use Refresh portfolio prices for individual option end-of-day closes.',
    );
  }
  async fx(_base: string, _quote: string): Promise<FeedResult> {
    void _base;
    void _quote;
    throw new MarketError(
      'FX_UNAVAILABLE',
      'FX is not enabled for Massive Basic. Non-USD balances remain unconverted.',
    );
  }
}
