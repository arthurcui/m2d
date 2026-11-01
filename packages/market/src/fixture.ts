import { Decimal } from 'decimal.js';
import type { Instrument } from '@m2d/portfolio';
import { instrumentKey } from '@m2d/portfolio';
import {
  MarketError,
  type MarketProvider,
  type Evidence,
  type FeedResult,
  type ListingLookup,
} from './contracts.js';
const prices: Record<string, string> = {
  TSLA: '400',
  NVDA: '200',
  AAPL: '250',
  CRWV: '100',
  SPY: '600',
  IBIT: '60',
  TSLL: '20',
  OPEN: '5',
};
export class FixtureMarketProvider implements MarketProvider {
  id = 'fixture' as const;
  configured = true;
  constructor(private now = () => new Date().toISOString()) {}
  evidence(id: string): Evidence {
    return {
      provider: this.id,
      sourceRecordId: id,
      asOf: '2026-10-30T20:00:00.000Z',
      receivedAt: this.now(),
      availableAt: this.now(),
      session: 'CLOSED',
      delayedMinutes: 15,
      quality: 'FIXTURE',
      entitlement: 'Synthetic offline examples; not market prices',
    };
  }
  async fetchListing(lookup: ListingLookup): Promise<FeedResult> {
    const names: Record<string, string> = {
      TSLA: 'Tesla, Inc.',
      NVDA: 'NVIDIA Corporation',
      AAPL: 'Apple Inc.',
      CRWV: 'CoreWeave, Inc.',
      SPY: 'SPDR S&P 500 ETF Trust',
      IBIT: 'iShares Bitcoin Trust ETF',
      TSLL: 'Direxion Daily TSLA Bull 2X Shares',
      OPEN: 'Opendoor Technologies Inc.',
    };
    if (!names[lookup.symbol] || lookup.currency !== 'USD')
      throw new MarketError('NO_COVERAGE', 'No fixture listing.');
    const value = {
      ...this.evidence(`listing:${lookup.symbol}`),
      lookup,
      name: names[lookup.symbol]!,
      exchange: lookup.exchange === 'UNKNOWN' ? 'NASDAQ' : lookup.exchange,
      assetType: ['SPY', 'IBIT', 'TSLL'].includes(lookup.symbol)
        ? ('ETF' as const)
        : ('STOCK' as const),
      logo: {
        mime: 'image/svg+xml' as const,
        base64: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24" rx="6" fill="#23584a"/><path d="M9 22V10h4l3 6 3-6h4v12h-4v-6l-3 5-3-5v6z" fill="white"/></svg>',
        ).toString('base64'),
      },
      logoIssue: null,
    };
    return {
      payload: { kind: 'listing', value },
      raw: { fixture: 'listing-v1', symbol: lookup.symbol },
    };
  }
  async quote(instrument: Instrument): Promise<FeedResult> {
    const price = prices[instrument.symbol];
    if (
      !price ||
      instrument.currency !== 'USD' ||
      instrument.assetType === 'OPTION'
    )
      throw new MarketError(
        'NO_COVERAGE',
        'No fixture quote for this exact instrument.',
      );
    const value = {
      ...this.evidence(instrumentKey(instrument)),
      instrument,
      bid: null,
      ask: null,
      last: price,
      kind: 'REGULAR_CLOSE' as const,
    };
    return {
      payload: { kind: 'quote', value },
      raw: { fixture: 'market-v1', value },
    };
  }
  async bars(symbol: string, exchange = 'NASDAQ'): Promise<FeedResult> {
    const price = prices[symbol];
    if (!price)
      throw new MarketError('NO_COVERAGE', 'No fixture bars for this symbol.');
    const value = Array.from({ length: 6 }, (_, i) => {
      const step = new Decimal(price).times('0.01');
      const close = new Decimal(price).minus(step.times(5 - i));
      const start = `2026-10-30T${14 + i}:00:00.000Z`;
      return {
        ...this.evidence(`${symbol}:${start}`),
        asOf: `2026-10-30T${15 + i}:00:00.000Z`,
        session: 'REGULAR' as const,
        symbol,
        currency: 'USD',
        exchange,
        interval: '1h' as const,
        start,
        open: close.minus(step).toFixed(),
        high: close.plus(step).toFixed(),
        low: close.minus(step.times(2)).toFixed(),
        close: close.toFixed(),
        volume: '1000000',
        adjustment: 'NONE' as const,
      };
    });
    return {
      payload: { kind: 'bars', value },
      raw: { fixture: 'market-v1', value },
    };
  }
  async fx(base: string, quote: string): Promise<FeedResult> {
    const rate =
      base === 'CAD' && quote === 'USD'
        ? '0.72'
        : base === 'USD' && quote === 'CAD'
          ? '1.388888888889'
          : null;
    if (!rate)
      throw new MarketError('NO_COVERAGE', 'No fixture FX for this pair.');
    const value = { ...this.evidence(`${base}/${quote}`), base, quote, rate };
    return {
      payload: { kind: 'fx', value },
      raw: { fixture: 'market-v1', value },
    };
  }
  async options(symbol: string, expiry: string): Promise<FeedResult> {
    if (symbol !== 'TSLA' || expiry !== '2026-12-18')
      throw new MarketError(
        'NO_COVERAGE',
        'Fixture options cover TSLA 2026-12-18 only.',
      );
    const instrument: Instrument = {
      assetType: 'OPTION',
      symbol: 'TSLA',
      exchange: 'NASDAQ',
      currency: 'USD',
      optionRight: 'CALL',
      expiry,
      strike: '450',
      multiplier: '100',
      underlying: 'TSLA',
      deliverable: 'STANDARD',
    };
    const value = [
      {
        quote: {
          ...this.evidence(instrumentKey(instrument)),
          instrument,
          bid: '5',
          ask: '7',
          last: '6',
          kind: 'REGULAR_CLOSE' as const,
        },
        iv: null,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        volume: null,
        openInterest: null,
      },
    ];
    return {
      payload: { kind: 'options', value },
      raw: { fixture: 'market-v1', value },
    };
  }
}
