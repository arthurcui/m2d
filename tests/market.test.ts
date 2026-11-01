import { describe, it, expect, vi } from 'vitest';
import {
  FixtureMarketProvider,
  TwelveDataProvider,
  equitySession,
  quoteSchema,
  payloadSchema,
  qualityAt,
  valuePortfolio,
  type Quote,
} from '../packages/market/src/index.js';
import type { Instrument, State } from '../packages/portfolio/src/index.js';
const now = '2026-10-31T20:00:00.000Z';
const stock: Instrument = {
  assetType: 'STOCK',
  symbol: 'TSLA',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
};
const option: Instrument = {
  ...stock,
  assetType: 'OPTION',
  optionRight: 'CALL',
  expiry: '2026-12-18',
  strike: '450',
  multiplier: '100',
  underlying: 'TSLA',
  deliverable: 'STANDARD',
};
const state: State = {
  accounts: [
    {
      accountKey: 'Test',
      displayName: 'Test',
      institution: 'Manual',
      accountType: 'CASH',
      baseCurrency: 'USD',
      active: true,
      notes: '',
    },
  ],
  positions: [
    {
      accountKey: 'Test',
      instrument: stock,
      quantity: '100',
      averageCost: '350',
      quality: 'BASELINE_ESTIMATE',
      notes: '',
    },
    {
      accountKey: 'Test',
      instrument: option,
      quantity: '-1',
      averageCost: '6',
      quality: 'BASELINE_ESTIMATE',
      notes: '',
    },
  ],
  cash: [{ accountKey: 'Test', currency: 'USD', balance: '600' }],
};
const fixture = new FixtureMarketProvider(() => now);
async function data() {
  const q = await fixture.quote(stock),
    o = await fixture.options('TSLA', '2026-12-18');
  if (q.payload.kind !== 'quote' || o.payload.kind !== 'options')
    throw new Error();
  return [q.payload.value, o.payload.value[0]!.quote];
}
describe('market quality and valuation', () => {
  it('uses signed option liabilities and exact decimals, not premium profit', async () => {
    const v = valuePortfolio(state, await data(), [], 'USD', now);
    expect(v.nav).toBe('40000');
    expect(v.positions[1]?.marketValue).toBe('-600');
    expect(v.positions[1]?.unrealized).toBe('0');
    expect(v.positions[0]?.unrealized).toBe('5000');
    expect(v.quality).toBe('FIXTURE');
    expect(
      valuePortfolio(
        {
          ...state,
          cash: [{ accountKey: 'Test', currency: 'CAD', balance: '0' }],
        },
        await data(),
        [],
        'USD',
        now,
      ).nav,
    ).toBe('39400');
  });
  it('missing prices, FX and cost cannot silently become zero or invented P&L', async () => {
    const s: State = {
      ...state,
      cash: [{ accountKey: 'Test', currency: 'CAD', balance: '1000' }],
      positions: state.positions.map((p) => ({
        ...p,
        averageCost: null,
        quality: 'UNKNOWN',
      })),
    };
    const v = valuePortfolio(s, (await data()).slice(0, 1), [], 'USD', now);
    expect(v.nav).toBeNull();
    expect(v.missing).toBe(2);
    expect(v.knownValue).toBe('40000');
    expect(v.positions[0]?.unrealized).toBeNull();
  });
  it('converts explicit FX and labels mixed evidence', async () => {
    const result = await fixture.fx('CAD', 'USD');
    if (result.payload.kind !== 'fx') throw new Error();
    const v = valuePortfolio(
      {
        ...state,
        cash: [{ accountKey: 'Test', currency: 'CAD', balance: '1000' }],
      },
      await data(),
      [{ ...result.payload.value, asOf: '2026-10-29T20:00:00Z' }],
      'USD',
      now,
    );
    expect(v.nav).toBe('40120');
    expect(v.mixedTimestamps).toBe(true);
    expect(v.historicalPerformance).toBe('UNKNOWN');
  });
  it('rejects wrong instrument and future/unavailable evidence for valuation', async () => {
    const q = (await data())[0]!;
    expect(
      valuePortfolio(
        state,
        [{ ...q, instrument: { ...stock, exchange: 'NYSE' } }],
        [],
        'USD',
        now,
      ).nav,
    ).toBeNull();
    expect(
      valuePortfolio(
        state,
        [{ ...q, availableAt: '2026-11-01T00:00:00Z' }],
        [],
        'USD',
        now,
      ).positions[0]?.mark,
    ).toBeNull();
  });
  it('closed/delayed quotes stay watch-only and crossed prices are rejected', async () => {
    const q = (await data())[0]!;
    expect(qualityAt(q, now)).toEqual({
      freshness: 'STALE',
      eligibility: 'WATCH_ONLY',
    });
    expect(quoteSchema.safeParse({ ...q, bid: '10', ask: '9' }).success).toBe(
      false,
    );
    expect(
      quoteSchema.safeParse({ ...q, bid: '0', ask: '0', last: '0' }).success,
    ).toBe(false);
    expect(
      valuePortfolio(state, [{ ...q, bid: '0', ask: '0' }], [], 'USD', now)
        .positions[0]?.mark,
    ).toBe('400');
  });
  it('fixture bars satisfy OHLCV constraints and missing Greeks remain null', async () => {
    expect(
      payloadSchema.safeParse((await fixture.bars('OPEN')).payload).success,
    ).toBe(true);
    const o = await fixture.options('TSLA', '2026-12-18');
    expect(
      o.payload.kind === 'options' && o.payload.value[0]?.delta,
    ).toBeNull();
    await expect(
      fixture.quote({ ...stock, symbol: 'UNSUPPORTED' }),
    ).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
  it.each([
    ['2026-03-06T14:30:00Z', 'REGULAR'],
    ['2026-03-09T13:30:00Z', 'REGULAR'],
    ['2026-07-03T15:00:00Z', 'CLOSED'],
    ['2026-11-27T17:59:00Z', 'REGULAR'],
    ['2026-11-27T18:00:00Z', 'POST'],
    ['2026-11-27T22:00:00Z', 'CLOSED'],
    ['2026-10-31T15:00:00Z', 'CLOSED'],
    ['2030-01-02T15:00:00Z', 'UNKNOWN'],
  ])('uses New York DST/holidays/early closes at %s', (at, expected) =>
    expect(equitySession(at)).toBe(expected),
  );
});
describe('Twelve Data adapter (mocked transport)', () => {
  it('preserves FX JSON precision without numeric rounding', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '{"symbol":"CAD/USD","rate":123456789012345678.123456789123,"timestamp":1793390400}',
        ),
      );
    const result = await new TwelveDataProvider('test', null, transport, () =>
      Date.parse(now),
    ).fx('CAD', 'USD');
    expect(result.payload.kind === 'fx' && result.payload.value.rate).toBe(
      '123456789012345678.123456789123',
    );
    expect(result.raw).toContain('123456789012345678.123456789123');
  });
  function provider(body: unknown) {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body)));
    return {
      transport,
      p: new TwelveDataProvider('test-key', 15, transport, () =>
        Date.parse(now),
      ),
    };
  }
  const raw = {
    symbol: 'TSLA',
    currency: 'USD',
    exchange: 'NASDAQ',
    timestamp: 1793390400,
    close: '400',
    is_market_open: false,
  };
  it('normalizes delayed regular-close prices without asserting after-hours trading', async () => {
    const { p, transport } = provider(raw);
    const result = await p.quote(stock);
    const q = result.payload.kind === 'quote' ? result.payload.value : null;
    expect(q?.session).toBe('CLOSED');
    expect(q?.quality).toBe('DELAYED');
    expect(q?.kind).toBe('REGULAR_CLOSE');
    expect(transport.mock.calls[0]?.[0]?.toString()).toContain('prepost=false');
    await expect(p.quote(stock)).rejects.toMatchObject({
      code: 'MARKET_RATE_LIMIT',
    });
  });
  it('does not call transport without a key or licensed options support', async () => {
    const transport = vi.fn<typeof fetch>();
    const p = new TwelveDataProvider('', null, transport);
    await expect(p.quote(stock)).rejects.toMatchObject({
      code: 'MARKET_NOT_CONFIGURED',
    });
    await expect(p.options('TSLA', '2026-12-18')).rejects.toMatchObject({
      code: 'OPTIONS_UNAVAILABLE',
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects ambiguous identities and malformed prices', async () => {
    await expect(
      provider({ ...raw, exchange: 'NYSE' }).p.quote(stock),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    await expect(
      provider({ ...raw, close: 'NaN' }).p.quote(stock),
    ).rejects.toMatchObject({ code: 'INVALID_MARKET_DATA' });
  });
  it('sanitizes provider errors and never falls back to fixtures', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('https://api.twelvedata.com?apikey=secret'));
    const p = new TwelveDataProvider('secret', null, transport);
    await expect(p.quote(stock)).rejects.toThrow(
      'Market provider could not be reached',
    );
    await expect(p.quote(stock)).rejects.toMatchObject({
      code: 'MARKET_RATE_LIMIT',
    });
  });
  it('normalizes UTC bars with explicit adjustment metadata', async () => {
    const rawBars = {
      meta: { symbol: 'TSLA', currency: 'USD', exchange: 'NASDAQ' },
      values: [
        {
          datetime: '2026-10-30 14:00:00',
          open: '390',
          high: '405',
          low: '385',
          close: '400',
          volume: '1000',
        },
      ],
    };
    const result = await provider(rawBars).p.bars('TSLA');
    expect(payloadSchema.safeParse(result.payload).success).toBe(true);
    expect(
      result.payload.kind === 'bars' && result.payload.value[0]?.start,
    ).toBe('2026-10-30T14:00:00Z');
  });
  it('preserves explicit FX direction and timestamp', async () => {
    const result = await provider({
      symbol: 'CAD/USD',
      rate: 0.72,
      timestamp: 1793390400,
    }).p.fx('CAD', 'USD');
    expect(result.payload.kind === 'fx' && result.payload.value.rate).toBe(
      '0.72',
    );
  });
});
export { stock, state, fixture };
export type { Quote };
