import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  amount,
  nonnegative,
  positive,
  currency,
  instrumentSchema,
  type Instrument,
} from '@m2d/portfolio';

export const symbolSchema = z.string().regex(/^[A-Z0-9.^-]{1,24}$/);
export const sessionSchema = z.enum([
  'PRE',
  'REGULAR',
  'POST',
  'CLOSED',
  'UNKNOWN',
]);
export const evidenceSchema = z.object({
  provider: z.enum(['fixture', 'twelvedata', 'massive', 'ibkr']),
  sourceRecordId: z.string().min(1).max(200),
  asOf: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  availableAt: z.iso.datetime(),
  session: sessionSchema,
  delayedMinutes: z.number().nonnegative().nullable(),
  quality: z.enum(['VALID', 'DELAYED', 'UNKNOWN', 'FIXTURE']),
  entitlement: z.string().max(200),
});
export const listingLookupSchema = z.object({
  symbol: symbolSchema,
  exchange: z.string().regex(/^[A-Z0-9.-]{1,20}$/),
  currency,
  assetType: z.enum(['STOCK', 'ETF', 'EQUITY']),
});
export type ListingLookup = z.infer<typeof listingLookupSchema>;
export function listingLookup(instrument: Instrument): ListingLookup {
  return {
    symbol: instrument.underlying ?? instrument.symbol,
    exchange:
      instrument.assetType === 'OPTION' ? 'UNKNOWN' : instrument.exchange,
    currency: instrument.currency,
    assetType:
      instrument.assetType === 'OPTION' ? 'EQUITY' : instrument.assetType,
  };
}
export function listingKey(lookup: ListingLookup) {
  return [
    lookup.symbol,
    lookup.exchange,
    lookup.currency,
    lookup.assetType,
  ].join(':');
}
export const listingSchema = evidenceSchema.extend({
  lookup: listingLookupSchema,
  name: z.string().trim().min(1).max(500),
  exchange: z.string().regex(/^[A-Z0-9.-]{1,20}$/),
  assetType: z.enum(['STOCK', 'ETF']).nullable(),
  logo: z
    .object({
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
      base64: z
        .string()
        .min(4)
        .max(350000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .nullable(),
  logoIssue: z.enum(['NOT_PROVIDED', 'UNAVAILABLE']).nullable(),
});
export type Listing = z.infer<typeof listingSchema>;
export function listingCacheMs(value: Listing) {
  return value.logoIssue === 'UNAVAILABLE' ? 5 * 60000 : 7 * 86400000;
}
export type ListingView = Pick<
  Listing,
  | 'lookup'
  | 'name'
  | 'exchange'
  | 'assetType'
  | 'provider'
  | 'asOf'
  | 'logoIssue'
> & {
  id: string;
  logoUrl: string | null;
};
export type ListingOverview = {
  provider: string;
  configured: boolean;
  listings: Record<string, ListingView>;
  requests: Array<{ kind: 'listing'; lookup: ListingLookup }>;
};
export const quoteSchema = evidenceSchema
  .extend({
    instrument: instrumentSchema,
    // Provider-verified listing metadata; never rewrites the ledger identity.
    resolvedExchange: z
      .string()
      .regex(/^[A-Z0-9.-]{1,20}$/)
      .optional(),
    bid: nonnegative.nullable(),
    ask: nonnegative.nullable(),
    last: nonnegative.nullable(),
    kind: z.enum(['LAST', 'REGULAR_CLOSE', 'EOD_CLOSE']),
  })
  .superRefine((q, c) => {
    if (q.bid !== null && q.ask !== null && new Decimal(q.bid).gt(q.ask))
      c.addIssue({ code: 'custom', message: 'Crossed quote' });
    if (
      (q.last === null || new Decimal(q.last).isZero()) &&
      (q.bid === null ||
        q.ask === null ||
        new Decimal(q.bid).isZero() ||
        new Decimal(q.ask).isZero())
    )
      c.addIssue({
        code: 'custom',
        message:
          'Quote has no usable positive price; zero placeholders cannot erase a liability',
      });
  });
export const barSchema = evidenceSchema
  .extend({
    symbol: symbolSchema,
    currency,
    exchange: z.string(),
    interval: z.literal('1h'),
    start: z.iso.datetime(),
    open: positive,
    high: positive,
    low: positive,
    close: positive,
    volume: nonnegative.nullable(),
    adjustment: z.enum(['NONE', 'UNKNOWN']),
  })
  .superRefine((b, c) => {
    if (
      new Decimal(b.low).gt(b.high) ||
      new Decimal(b.high).lt(Decimal.max(b.open, b.close)) ||
      new Decimal(b.low).gt(Decimal.min(b.open, b.close))
    )
      c.addIssue({ code: 'custom', message: 'Invalid OHLC range' });
  });
export const fxSchema = evidenceSchema.extend({
  base: currency,
  quote: currency,
  rate: positive,
});
export const optionSchema = z.object({
  quote: quoteSchema.refine((q) => q.instrument.assetType === 'OPTION'),
  iv: nonnegative.nullable(),
  delta: amount.nullable(),
  gamma: amount.nullable(),
  theta: amount.nullable(),
  vega: amount.nullable(),
  volume: nonnegative.nullable(),
  openInterest: nonnegative.nullable(),
});
export const listingCandidateSchema = z.object({
  id: z.string().min(1).max(100),
  symbol: symbolSchema,
  name: z.string().min(1).max(500),
  exchange: z.enum(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS']),
  currency: z.literal('USD'),
});
export type ListingCandidate = z.infer<typeof listingCandidateSchema>;
export const resolutionSchema = evidenceSchema.extend({
  symbol: symbolSchema,
  candidates: z.array(listingCandidateSchema).max(100),
});
export type ListingResolution = z.infer<typeof resolutionSchema>;
export const payloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resolution'), value: resolutionSchema }),
  z.object({ kind: z.literal('listing'), value: listingSchema }),
  z.object({ kind: z.literal('quote'), value: quoteSchema }),
  z.object({ kind: z.literal('bars'), value: z.array(barSchema).max(100) }),
  z.object({ kind: z.literal('fx'), value: fxSchema }),
  z.object({
    kind: z.literal('options'),
    value: z.array(optionSchema).max(100),
  }),
]);
export type Quote = z.infer<typeof quoteSchema>;
export type Bar = z.infer<typeof barSchema>;
export type Fx = z.infer<typeof fxSchema>;
export type OptionSnapshot = z.infer<typeof optionSchema>;
export type Payload = z.infer<typeof payloadSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type FeedResult = { payload: Payload; raw: unknown };
export interface QuoteProvider {
  quote(instrument: Instrument): Promise<FeedResult>;
}
export interface BarsProvider {
  bars(
    symbol: string,
    exchange?: string,
    listingId?: string,
  ): Promise<FeedResult>;
}
export interface FxProvider {
  fx(base: string, quote: string): Promise<FeedResult>;
}
export interface OptionsProvider {
  options(symbol: string, expiry: string): Promise<FeedResult>;
}
export interface MarketProvider
  extends QuoteProvider, BarsProvider, FxProvider, OptionsProvider {
  id: 'fixture' | 'twelvedata' | 'massive' | 'ibkr';
  configured: boolean;
  fetchListing?(lookup: ListingLookup): Promise<FeedResult>;
  resolveListing?(symbol: string): Promise<FeedResult>;
}
export class MarketError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function qualityAt(e: Evidence, now: string) {
  const age = Date.parse(now) - Date.parse(e.asOf);
  return {
    freshness: age < 0 ? 'INVALID' : age > 90_000 ? 'STALE' : 'FRESH',
    // M3 valuations are indicative, never execution signals.
    eligibility: 'WATCH_ONLY' as const,
  };
}
