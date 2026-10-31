import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  nonnegative,
  positive,
  instrumentKey,
  type Instrument,
} from '@m2d/portfolio';
import {
  MarketError,
  type MarketProvider,
  type FeedResult,
  type Evidence,
} from './contracts.js';
import { equitySession } from './calendar.js';
const quoteResponse = z.object({
  symbol: z.string(),
  currency: z.string(),
  exchange: z.string(),
  timestamp: z.number().int().positive(),
  close: nonnegative,
  is_market_open: z.boolean(),
});
const barsResponse = z.object({
  meta: z.object({
    symbol: z.string(),
    currency: z.string(),
    exchange: z.string(),
  }),
  values: z
    .array(
      z.object({
        datetime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        open: positive,
        high: positive,
        low: positive,
        close: positive,
        volume: nonnegative.optional(),
      }),
    )
    .max(100),
});
const fxResponse = z.object({
  symbol: z.string(),
  rate: positive,
  timestamp: z.number().int().positive(),
});

export class TwelveDataProvider implements MarketProvider {
  id = 'twelvedata' as const;
  configured: boolean;
  private nextCall = 0;
  private blockedUntil = 0;
  constructor(
    private key: string,
    private delay: number | null = null,
    private transport: typeof fetch = fetch,
    private clock = () => Date.now(),
  ) {
    this.configured = !!key.trim();
  }
  private evidence(
    id: string,
    epoch: number,
    session: Evidence['session'],
  ): Evidence {
    const now = new Date(this.clock()).toISOString();
    return {
      provider: this.id,
      sourceRecordId: id,
      asOf: new Date(epoch * 1000).toISOString(),
      receivedAt: now,
      availableAt: now,
      session,
      delayedMinutes: this.delay,
      quality:
        this.delay === null ? 'UNKNOWN' : this.delay > 0 ? 'DELAYED' : 'VALID',
      entitlement:
        'Configured data plan; indicative last prices, no execution feed',
    };
  }
  private async request(
    path: string,
    params: Record<string, string>,
  ): Promise<{ body: unknown; raw: string }> {
    if (!this.configured)
      throw new MarketError(
        'MARKET_NOT_CONFIGURED',
        'Set TWELVE_DATA_API_KEY in the backend environment.',
        503,
      );
    if (this.clock() < this.blockedUntil)
      throw new MarketError(
        'MARKET_RATE_LIMIT',
        'Market provider is cooling down. Retry later.',
        429,
      );
    if (this.clock() < this.nextCall)
      throw new MarketError(
        'MARKET_RATE_LIMIT',
        'Allow 8 seconds between provider requests.',
        429,
      );
    // No hidden retry charges or secret-bearing URLs in persisted errors.
    this.nextCall = this.clock() + 8000;
    const url = new URL(`https://api.twelvedata.com/${path}`);
    for (const [k, v] of Object.entries({ ...params, apikey: this.key }))
      url.searchParams.set(k, v);
    try {
      const response = await this.transport(url, {
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
      if (response.status === 429) {
        this.blockedUntil = this.clock() + 60000;
        throw new MarketError(
          'MARKET_RATE_LIMIT',
          'Provider rate limit; retry after one minute.',
          429,
        );
      }
      if (!response.ok)
        throw new MarketError(
          'MARKET_PROVIDER_ERROR',
          'Market provider rejected the request. Check data entitlements.',
          502,
        );
      const sourceText = await response.text();
      if (sourceText.length > 2_000_000)
        throw new MarketError(
          'INVALID_MARKET_DATA',
          'Provider response exceeded the supported size.',
          502,
        );
      // Node 24 exposes the original JSON numeric token to revivers. Preserve
      // FX precision without first passing the amount through a binary float.
      const raw: unknown = JSON.parse(
        sourceText,
        (key: string, value: unknown, context?: { source: string }) =>
          key === 'rate' && typeof value === 'number' && context?.source
            ? new Decimal(context.source).toFixed()
            : value,
      );
      if (
        raw &&
        typeof raw === 'object' &&
        'status' in raw &&
        raw.status === 'error'
      ) {
        this.blockedUntil = this.clock() + 60000;
        throw new MarketError(
          'MARKET_PROVIDER_ERROR',
          'Provider returned an error. Check symbol, key, entitlements, or quota.',
          502,
        );
      }
      return { body: raw, raw: sourceText };
    } catch (e) {
      if (e instanceof MarketError) throw e;
      this.blockedUntil = this.clock() + 30000;
      throw new MarketError(
        'MARKET_UNAVAILABLE',
        'Market provider could not be reached. Last stored data remains available.',
        503,
      );
    }
  }
  async quote(instrument: Instrument): Promise<FeedResult> {
    if (instrument.assetType === 'OPTION')
      throw new MarketError(
        'OPTIONS_UNAVAILABLE',
        'This adapter does not provide licensed options quotes or Greeks.',
      );
    if (!['NASDAQ', 'NYSE', 'AMEX'].includes(instrument.exchange))
      throw new MarketError(
        'UNSUPPORTED_EXCHANGE',
        'Select an unambiguous NASDAQ, NYSE or AMEX instrument; no exchange is guessed.',
      );
    const { body, raw } = await this.request('quote', {
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      prepost: 'false',
    });
    const result = quoteResponse.safeParse(body);
    if (!result.success)
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'Provider quote failed validation.',
        502,
      );
    const q = result.data;
    if (
      q.symbol !== instrument.symbol ||
      q.currency !== instrument.currency ||
      q.exchange !== instrument.exchange
    )
      throw new MarketError(
        'INSTRUMENT_MISMATCH',
        'Provider response does not match the requested instrument.',
        502,
      );
    const session = q.is_market_open
      ? equitySession(new Date(q.timestamp * 1000).toISOString())
      : 'CLOSED';
    return {
      raw,
      payload: {
        kind: 'quote',
        value: {
          ...this.evidence(instrumentKey(instrument), q.timestamp, session),
          instrument,
          bid: null,
          ask: null,
          last: q.close,
          kind: q.is_market_open ? 'LAST' : 'REGULAR_CLOSE',
        },
      },
    };
  }
  async bars(symbol: string, exchange = 'NASDAQ'): Promise<FeedResult> {
    const { body, raw } = await this.request('time_series', {
      symbol,
      exchange,
      interval: '1h',
      outputsize: '60',
      timezone: 'UTC',
      adjust: 'none',
      prepost: 'false',
    });
    const result = barsResponse.safeParse(body);
    if (
      !result.success ||
      result.data.meta.symbol !== symbol ||
      result.data.meta.exchange !== exchange
    )
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'Provider bars failed validation.',
        502,
      );
    const { meta, values } = result.data;
    const value = values
      .map((b) => {
        const start = b.datetime.replace(' ', 'T') + 'Z';
        const end = Date.parse(start) + 3600000;
        return {
          ...this.evidence(
            `${symbol}:${start}`,
            end / 1000,
            ['NASDAQ', 'NYSE', 'AMEX'].includes(meta.exchange)
              ? equitySession(start)
              : 'UNKNOWN',
          ),
          symbol,
          currency: meta.currency,
          exchange: meta.exchange,
          interval: '1h' as const,
          start,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume ?? null,
          adjustment: 'NONE' as const,
        };
      })
      .filter((b) => Date.parse(b.asOf) <= this.clock())
      .sort((a, b) => a.start.localeCompare(b.start));
    return { raw, payload: { kind: 'bars', value } };
  }
  async fx(base: string, quote: string): Promise<FeedResult> {
    const { body, raw } = await this.request('exchange_rate', {
      symbol: `${base}/${quote}`,
    });
    const result = fxResponse.safeParse(body);
    if (!result.success || result.data.symbol !== `${base}/${quote}`)
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'Provider FX failed validation.',
        502,
      );
    return {
      raw,
      payload: {
        kind: 'fx',
        value: {
          ...this.evidence(
            `${base}/${quote}`,
            result.data.timestamp,
            'UNKNOWN',
          ),
          base,
          quote,
          rate: result.data.rate,
        },
      },
    };
  }
  async options(_symbol: string, _expiry: string): Promise<FeedResult> {
    void _symbol;
    void _expiry;
    throw new MarketError(
      'OPTIONS_UNAVAILABLE',
      'Licensed options chain and Greeks are not available in the Twelve Data adapter. Holdings remain unpriced.',
    );
  }
}
