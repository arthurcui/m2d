import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { instrumentSchema, type Instrument } from '@m2d/portfolio';
import {
  MarketError,
  listingCandidateSchema,
  payloadSchema,
  type FeedResult,
  type MarketProvider,
  type Quote,
  listingLookupSchema,
  type ListingLookup,
} from './contracts.js';
import { equitySession } from './calendar.js';

export const IBKR_READ_TOOLS = [
  'search_contracts',
  'get_price_snapshot',
  'get_price_history',
  'get_option_parameters',
  'get_option_data',
] as const;
export type IbkrReadTool = (typeof IBKR_READ_TOOLS)[number];
export interface IbkrSession {
  call(
    name: IbkrReadTool,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; raw: unknown }>;
  close(): Promise<void>;
}
const numberText = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z.string().regex(/^-?\d+(?:\.\d+)?$/),
);
// IBKR history may encode large volumes as scientific-notation strings.
const historyVolumeText = z
  .preprocess(
    (v) => (typeof v === 'number' ? String(v) : v),
    z
      .string()
      .max(100)
      .regex(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,2})?$/),
  )
  .transform((v) => new Decimal(v).toFixed());
const positiveText = numberText.refine((v) => new Decimal(v).gt(0));
const id = z.coerce.number().int().positive().safe();
const listingSchema = z.object({
  results: z
    .array(
      z.object({
        underlying_contract_id: id.optional(),
        symbol: z.string().optional(),
        exchange: z.string().optional(),
        country_code: z.string().optional(),
        description: z.string().trim().max(500).optional(),
        sections: z.array(z.object({ security_type: z.string() })).optional(),
      }),
    )
    .max(500),
});
const parametersSchema = z.object({
  current_exchange: z.string(),
  expirations: z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        date: z.string().regex(/^\d{8}$/),
        trading_class: z.string().optional(),
      }),
    )
    .max(500),
});
const chainSchema = z.object({
  currency: z.literal('USD'),
  exchange: z.literal('SMART'),
  contracts: z
    .array(
      z.object({
        strike: positiveText,
        call_contract_id: id.optional(),
        call_description: z.string().optional(),
        put_contract_id: id.optional(),
        put_description: z.string().optional(),
      }),
    )
    .max(500),
});
const snapshotSchema = z.object({
  last: z
    .object({
      price: positiveText.optional(),
      ts: z.coerce.number().positive().optional(),
      is_close: z.boolean().optional(),
      halted: z.boolean().optional(),
    })
    .optional(),
  'bid-ask': z
    .object({
      bid: positiveText.optional(),
      ask: positiveText.optional(),
      ts: z.coerce.number().positive().optional(),
    })
    .optional(),
  'top-status': z.object({ status: z.string().max(60) }).optional(),
});
const usExchanges = ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS'];
const noCoverage = () =>
  new MarketError(
    'NO_COVERAGE',
    'IBKR returned no usable timestamped market observation.',
  );
function verifyOptionDescription(
  i: Instrument,
  description: string | undefined,
) {
  const match = description?.match(
    /^([A-Z0-9.-]+) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{1,2}) '(\d{2}) (\d+(?:\.\d+)?) (Call|Put)(?: \((\d+)\))?$/,
  );
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  if (
    !match ||
    match[1] !== i.underlying ||
    '20' +
      match[4] +
      '-' +
      String(months.indexOf(match[2]!) + 1).padStart(2, '0') +
      '-' +
      match[3]!.padStart(2, '0') !==
      i.expiry ||
    !new Decimal(match[5]!).eq(i.strike!) ||
    match[6]!.toUpperCase() !== i.optionRight ||
    (match[7] !== undefined && match[7] !== '100')
  )
    throw new MarketError(
      'INSTRUMENT_MISMATCH',
      'IBKR option description does not match the recorded standard contract.',
    );
}

/** MCP supplies STK for both stocks and ETFs; preserve the user-recorded class. */
export class IbkrMcpMarketDataProvider implements MarketProvider {
  readonly id = 'ibkr' as const;
  constructor(
    private readonly open: () => Promise<IbkrSession>,
    private readonly connected: () => boolean,
    private readonly clock = Date.now,
  ) {}
  get configured() {
    return this.connected();
  }
  async fetchListing(input: ListingLookup): Promise<FeedResult> {
    const lookup = listingLookupSchema.parse(input);
    if (lookup.currency !== 'USD')
      throw new MarketError(
        'UNSUPPORTED_INSTRUMENT',
        'IBKR listing details currently support USD US securities.',
      );
    return this.run(async (call) => {
      const row = await this.listing(call, lookup.symbol, lookup.exchange);
      if (!row.description)
        throw new MarketError(
          'INVALID_MARKET_DATA',
          'IBKR returned no listing description.',
        );
      const now = new Date(this.clock()).toISOString();
      return {
        kind: 'listing',
        value: {
          lookup,
          name: row.description,
          exchange: row.exchange!,
          assetType: null,
          logo: null,
          logoIssue: 'NOT_PROVIDED',
          provider: this.id,
          sourceRecordId: `listing:${row.underlying_contract_id}`,
          asOf: now,
          receivedAt: now,
          availableAt: now,
          session: 'UNKNOWN',
          delayedMinutes: null,
          quality: 'VALID',
          entitlement:
            'Listing description only; IBKR STK does not distinguish stocks from ETFs. No logo or price evidence.',
        },
      };
    });
  }
  private async run(
    action: (call: IbkrSession['call']) => Promise<FeedResult['payload']>,
  ): Promise<FeedResult> {
    if (!this.configured)
      throw new MarketError(
        'IBKR_AUTH_REQUIRED',
        'Connect IBKR on the Market page first.',
        401,
      );
    const deadline = this.clock() + 90000;
    const session = await this.open();
    const evidence: unknown[] = [];
    let calls = 0;
    try {
      const value = await action(async (name, args) => {
        if (++calls > 12 || this.clock() >= deadline)
          throw new MarketError(
            'IBKR_WORK_LIMIT',
            'This market refresh reached its bounded tool allowance.',
          );
        const result = await session.call(name, args);
        evidence.push({ tool: name, arguments: args, response: result.raw });
        return result;
      });
      return { payload: payloadSchema.parse(value), raw: { tools: evidence } };
    } catch (e) {
      if (e instanceof MarketError) throw e;
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'IBKR market data did not match the supported response format.',
        502,
      );
    } finally {
      await session.close();
    }
  }
  async resolveListing(symbol: string): Promise<FeedResult> {
    return this.run(async (call) => {
      const data = listingSchema.parse(
        (await call('search_contracts', { query: symbol, language: 'en_US' }))
          .data,
      );
      const rows = data.results.filter(
        (r) =>
          r.symbol === symbol &&
          r.country_code === 'US' &&
          r.exchange &&
          usExchanges.includes(r.exchange) &&
          r.sections?.some((s) => s.security_type === 'STK') &&
          r.underlying_contract_id,
      );
      const candidates = [
        ...new Map(
          rows.map((r) => [
            String(r.underlying_contract_id),
            listingCandidateSchema.parse({
              id: String(r.underlying_contract_id),
              symbol,
              name: r.description ?? symbol,
              exchange: r.exchange,
              currency: 'USD',
            }),
          ]),
        ).values(),
      ];
      const now = new Date(this.clock()).toISOString();
      return {
        kind: 'resolution',
        value: {
          provider: this.id,
          sourceRecordId: `resolve:${symbol}`,
          asOf: now,
          receivedAt: now,
          availableAt: now,
          session: 'UNKNOWN',
          quality: 'VALID',
          delayedMinutes: null,
          entitlement:
            'US stock/ETF listing identities only; not price evidence.',
          symbol,
          candidates,
        },
      };
    });
  }
  private async listing(
    call: IbkrSession['call'],
    symbol: string,
    exchange = 'UNKNOWN',
    listingId?: string,
  ) {
    const data = listingSchema.parse(
      (await call('search_contracts', { query: symbol, language: 'en_US' }))
        .data,
    );
    const matches = data.results.filter(
      (r) =>
        (!listingId || String(r.underlying_contract_id) === listingId) &&
        r.symbol === symbol &&
        r.country_code === 'US' &&
        r.exchange &&
        usExchanges.includes(r.exchange) &&
        (['US', 'UNKNOWN', 'SMART'].includes(exchange) ||
          r.exchange === exchange) &&
        r.sections?.some((s) => s.security_type === 'STK') &&
        r.underlying_contract_id,
    );
    if (matches.length !== 1)
      throw new MarketError(
        'INSTRUMENT_MISMATCH',
        'IBKR did not resolve a unique matching US listing.',
      );
    return matches[0]!;
  }
  private async optionRows(
    call: IbkrSession['call'],
    symbol: string,
    contractId: number,
    expiry: string,
    center: string,
  ) {
    const parameters = parametersSchema.parse(
      (
        await call('get_option_parameters', {
          underlying_contract_id: contractId,
          option_sec_type: 'OPT',
          option_exchange: 'SMART',
        })
      ).data,
    );
    const matches = parameters.expirations.filter(
      (e) =>
        e.date === expiry.replaceAll('-', '') && e.trading_class === symbol,
    );
    if (parameters.current_exchange !== 'SMART' || matches.length !== 1)
      throw new MarketError(
        'INSTRUMENT_MISMATCH',
        'IBKR option expiration or standard trading class is ambiguous.',
      );
    // Outward-round only the search window, never a contract strike or mark.
    const lower = Decimal.max(
      '0.01',
      new Decimal(center).mul('0.75').toDecimalPlaces(2, Decimal.ROUND_FLOOR),
    );
    const upper = new Decimal(center)
      .mul('1.25')
      .toDecimalPlaces(2, Decimal.ROUND_CEIL);
    // Numeric API bounds only; all price/strike arithmetic remains decimal-safe.
    if (
      !new Decimal(lower.toNumber().toString()).eq(lower) ||
      !new Decimal(upper.toNumber().toString()).eq(upper)
    )
      throw new MarketError(
        'UNSUPPORTED_INSTRUMENT',
        'Strike cannot be represented without rounding.',
      );
    return chainSchema.parse(
      (
        await call('get_option_data', {
          expiration_id: matches[0]!.id,
          min_strike: lower.toNumber(),
          max_strike: upper.toNumber(),
        })
      ).data,
    );
  }
  private async snapshot(
    call: IbkrSession['call'],
    instrument: Instrument,
    contractId: number,
    resolvedExchange: string,
  ): Promise<Quote> {
    const data = snapshotSchema.parse(
      (
        await call('get_price_snapshot', {
          contract_id: contractId,
          exchange: 'SMART',
          market_data_names: ['last', 'bid_ask', 'top_status'],
        })
      ).data,
    );
    const last = data.last;
    const book = data['bid-ask'];
    if (last?.halted)
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'IBKR reports a halted instrument.',
      );
    const seconds =
      last?.price && last.ts
        ? last.ts
        : book?.bid && book.ask && book.ts
          ? book.ts
          : null;
    if (!seconds) throw noCoverage();
    const asOf = new Date(seconds * 1000).toISOString();
    const now = new Date(this.clock()).toISOString();
    if (Date.parse(asOf) > this.clock())
      throw new MarketError(
        'INVALID_MARKET_DATA',
        'IBKR returned a future price timestamp.',
      );
    // A book without its own source timestamp must never inherit the last-trade time.
    const sameBookTime = book?.ts === seconds;
    const status = data['top-status']?.status ?? 'UNSPECIFIED';
    return {
      instrument,
      resolvedExchange,
      provider: 'ibkr',
      sourceRecordId: String(contractId) + ':' + asOf,
      asOf,
      receivedAt: now,
      availableAt: now,
      session: equitySession(asOf),
      delayedMinutes: null,
      quality: /DELAY/.test(status) ? 'DELAYED' : 'UNKNOWN',
      entitlement:
        'IBKR MCP snapshot status: ' + status + '; numeric delay unverified',
      bid: sameBookTime ? (book?.bid ?? null) : null,
      ask: sameBookTime ? (book?.ask ?? null) : null,
      last: last?.ts === seconds ? (last.price ?? null) : null,
      kind:
        last?.price && last.ts === seconds && last.is_close
          ? 'REGULAR_CLOSE'
          : 'LAST',
    };
  }
  async quote(input: Instrument) {
    const i = instrumentSchema.parse(input);
    if (i.currency !== 'USD')
      throw new MarketError(
        'UNSUPPORTED_INSTRUMENT',
        'The initial IBKR adapter supports USD US-listed stocks, ETFs and standard equity options.',
      );
    if (
      i.assetType === 'OPTION' &&
      (i.multiplier !== '100' ||
        i.deliverable !== 'STANDARD' ||
        !['UNKNOWN', 'US', 'SMART', 'OPRA', 'CBOE', ...usExchanges].includes(
          i.exchange,
        ))
    )
      throw new MarketError(
        'UNSUPPORTED_INSTRUMENT',
        'Only standard 100-share US equity options are supported.',
      );
    return this.run(async (call) => {
      const listing = await this.listing(
        call,
        i.underlying ?? i.symbol,
        i.assetType === 'OPTION' ? 'UNKNOWN' : i.exchange,
      );
      let contractId = listing.underlying_contract_id!;
      if (i.assetType === 'OPTION') {
        const rows = await this.optionRows(
          call,
          i.underlying!,
          contractId,
          i.expiry!,
          i.strike!,
        );
        const matches = rows.contracts.filter((r) =>
          new Decimal(r.strike).eq(i.strike!),
        );
        if (matches.length !== 1)
          throw new MarketError(
            'INSTRUMENT_MISMATCH',
            'IBKR did not return the exact option strike.',
          );
        verifyOptionDescription(
          i,
          i.optionRight === 'CALL'
            ? matches[0]!.call_description
            : matches[0]!.put_description,
        );
        contractId =
          (i.optionRight === 'CALL'
            ? matches[0]!.call_contract_id
            : matches[0]!.put_contract_id) ?? 0;
        if (!contractId) throw noCoverage();
      }
      return {
        kind: 'quote',
        value: await this.snapshot(
          call,
          i,
          contractId,
          i.assetType === 'OPTION' ? 'SMART' : listing.exchange!,
        ),
      };
    });
  }
  async bars(symbol: string, exchange = 'NASDAQ', listingId?: string) {
    return this.run(async (call) => {
      const listing = await this.listing(call, symbol, exchange, listingId);
      const data = z
        .object({
          chart_step: z.coerce.number().refine((n) => n === 3600),
          source: z.literal('Last'),
          delayed: z.coerce.number().optional(),
          time: z.array(z.iso.datetime()).max(500),
          open: z.array(positiveText).max(500),
          high: z.array(positiveText).max(500),
          low: z.array(positiveText).max(500),
          close: z.array(positiveText).max(500),
          volume: z.array(historyVolumeText).max(500).optional(),
        })
        .parse(
          (
            await call('get_price_history', {
              contract_id: listing.underlying_contract_id!,
              security_type: 'STK',
              exchange: 'SMART',
              outside_rth: false,
              step: 'ONE_HOUR',
              step_count: 100,
              include_corporate_actions: true,
            })
          ).data,
        );
      if (
        [
          data.open,
          data.high,
          data.low,
          data.close,
          ...(data.volume ? [data.volume] : []),
        ].some((v) => v.length !== data.time.length)
      )
        throw new MarketError(
          'INVALID_MARKET_DATA',
          'IBKR bar arrays have inconsistent lengths.',
        );
      const now = new Date(this.clock()).toISOString();
      const value = data.time.flatMap((start, n) => {
        const end = Date.parse(start) + 3600000;
        if (end > this.clock()) return [];
        const session = equitySession(start);
        return [
          {
            provider: 'ibkr' as const,
            sourceRecordId:
              String(listing.underlying_contract_id) + ':1h:' + start,
            asOf: new Date(end).toISOString(),
            receivedAt: now,
            availableAt: now,
            session:
              session === equitySession(new Date(end - 1).toISOString())
                ? session
                : ('UNKNOWN' as const),
            delayedMinutes: null,
            quality: data.delayed ? ('DELAYED' as const) : ('UNKNOWN' as const),
            entitlement:
              'IBKR MCP historical Last; adjustment and numeric delay unverified',
            symbol,
            currency: 'USD',
            exchange,
            interval: '1h' as const,
            start,
            open: data.open[n]!,
            high: data.high[n]!,
            low: data.low[n]!,
            close: data.close[n]!,
            volume: data.volume?.[n] ?? null,
            adjustment: 'UNKNOWN' as const,
          },
        ];
      });
      if (!value.length) throw noCoverage();
      return {
        kind: 'bars',
        value: value.sort((a, b) => a.start.localeCompare(b.start)).slice(-100),
      };
    });
  }
  async options(symbol: string, expiry: string) {
    return this.run(async (call) => {
      const listing = await this.listing(call, symbol);
      const base: Instrument = {
        assetType: 'STOCK',
        symbol,
        exchange: listing.exchange!,
        currency: 'USD',
        optionRight: null,
        expiry: null,
        strike: null,
        multiplier: '1',
        underlying: null,
        deliverable: null,
      };
      const spot = await this.snapshot(
        call,
        base,
        listing.underlying_contract_id!,
        listing.exchange!,
      );
      if (!spot.last) throw noCoverage();
      const rows = await this.optionRows(
        call,
        symbol,
        listing.underlying_contract_id!,
        expiry,
        spot.last,
      );
      const nearest = [...rows.contracts]
        .sort((a, b) =>
          new Decimal(a.strike)
            .minus(spot.last!)
            .abs()
            .cmp(new Decimal(b.strike).minus(spot.last!).abs()),
        )
        .slice(0, 3);
      const values = [];
      for (const row of nearest)
        for (const right of ['CALL', 'PUT'] as const) {
          const contractId =
            right === 'CALL' ? row.call_contract_id : row.put_contract_id;
          if (!contractId) continue;
          const instrument: Instrument = {
            ...base,
            assetType: 'OPTION',
            underlying: symbol,
            expiry,
            strike: row.strike,
            optionRight: right,
            multiplier: '100',
            deliverable: 'STANDARD',
            exchange: 'SMART',
          };
          verifyOptionDescription(
            instrument,
            right === 'CALL' ? row.call_description : row.put_description,
          );
          try {
            values.push({
              quote: await this.snapshot(call, instrument, contractId, 'SMART'),
              iv: null,
              delta: null,
              gamma: null,
              theta: null,
              vega: null,
              volume: null,
              openInterest: null,
            });
          } catch (e) {
            if (
              !(e instanceof MarketError) ||
              !['NO_COVERAGE', 'INVALID_MARKET_DATA'].includes(e.code)
            )
              throw e;
          }
        }
      if (!values.length) throw noCoverage();
      return { kind: 'options', value: values };
    });
  }
  async fx(): Promise<FeedResult> {
    throw new MarketError(
      'FX_UNAVAILABLE',
      'FX is not enabled in this IBKR integration.',
    );
  }
}
