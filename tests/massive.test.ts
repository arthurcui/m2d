import { describe, it, expect, vi } from 'vitest';
import {
  MassiveBasicProvider,
  massiveCompletedDate,
  massiveOptionTicker,
  payloadSchema,
  valuePortfolio,
} from '../packages/market/src/index.js';
import { readConfig } from '../packages/config/src/index.js';
import type { Instrument } from '../packages/portfolio/src/index.js';
const stock: Instrument = {
  assetType: 'STOCK',
  symbol: 'TSLA',
  currency: 'USD',
  exchange: 'NASDAQ',
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
  exchange: 'OPRA',
  optionRight: 'CALL',
  expiry: '2026-12-18',
  strike: '450',
  multiplier: '100',
  underlying: 'TSLA',
  deliverable: 'STANDARD',
};
const reference = {
  status: 'OK',
  results: {
    ticker: 'TSLA',
    market: 'stocks',
    locale: 'us',
    primary_exchange: 'XNAS',
    currency_name: 'usd',
    type: 'CS',
  },
};
const optionRef = {
  status: 'OK',
  results: {
    ticker: 'O:TSLA261218C00450000',
    underlying_ticker: 'TSLA',
    expiration_date: '2026-12-18',
    contract_type: 'call',
    strike_price: 450,
    shares_per_contract: 100,
  },
};
const close = {
  status: 'OK',
  symbol: 'TSLA',
  from: '2026-10-30',
  close: 400,
  afterHours: 999,
};
function setup(responses: (unknown | Response)[], key = 'mock-secret') {
  let now = Date.parse('2026-10-31T18:00:00Z');
  const times: number[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    times.push(now);
    const body = responses.shift();
    return body instanceof Response
      ? body
      : new Response(typeof body === 'string' ? body : JSON.stringify(body));
  });
  const gate = vi.fn(async () => {});
  const p = new MassiveBasicProvider(
    key,
    gate,
    transport,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  return { p, transport, gate, times };
}
describe('Massive Basic end-of-day adapter', () => {
  it('configures Massive explicitly without falling back or requiring a key at startup', () => {
    expect(
      readConfig({
        DATABASE_URL: 'postgres://localhost/m2d',
        MARKET_PROVIDER: 'massive',
      }).MARKET_PROVIDER,
    ).toBe('massive');
  });
  it('uses completed New York trading dates across weekends, holidays and DST', () => {
    expect(massiveCompletedDate(Date.parse('2026-10-31T18:00Z'))).toBe(
      '2026-10-30',
    );
    expect(massiveCompletedDate(Date.parse('2026-11-02T04:30Z'))).toBe(
      '2026-10-30',
    );
    expect(massiveCompletedDate(Date.parse('2026-11-27T12:00Z'))).toBe(
      '2026-11-25',
    );
    expect(() => massiveCompletedDate(Date.parse('2028-02-01T12:00Z'))).toThrow(
      'calendar',
    );
  });
  it('keeps daily close separate from after-hours and preserves numeric source precision', async () => {
    const { p, transport, gate, times } = setup([
      reference,
      '{"status":"OK","symbol":"TSLA","from":"2026-10-30","close":400.123456789123,"afterHours":999}',
    ]);
    const result = await p.quote(stock);
    expect(result.payload).toMatchObject({
      kind: 'quote',
      value: {
        last: '400.123456789123',
        bid: null,
        ask: null,
        kind: 'EOD_CLOSE',
        quality: 'DELAYED',
        delayedMinutes: null,
        session: 'CLOSED',
        asOf: '2026-10-31T03:59:59.999Z',
      },
    });
    expect(payloadSchema.safeParse(result.payload).success).toBe(true);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(13000);
    expect(transport.mock.calls[1]![0]!.toString()).toContain(
      '/2026-10-30?adjusted=false',
    );
    expect(transport.mock.calls[0]![0]!.toString()).not.toContain(
      'mock-secret',
    );
    expect(JSON.stringify(result)).not.toContain('mock-secret');
  });
  it('validates US ETF identity and permits explicit US listing labels', async () => {
    const etf = {
      ...stock,
      assetType: 'ETF' as const,
      symbol: 'SPY',
      exchange: 'US',
    };
    const { p } = setup([
      {
        status: 'OK',
        results: {
          ...reference.results,
          ticker: 'SPY',
          primary_exchange: 'ARCX',
          type: 'ETF',
        },
      },
      { ...close, symbol: 'SPY' },
    ]);
    expect((await p.quote(etf)).payload).toMatchObject({
      kind: 'quote',
      value: { instrument: etf, last: '400' },
    });
  });
  it('rejects wrong exchange, wrong symbol or currency before requesting a price', async () => {
    for (const patch of [
      { primary_exchange: 'XNYS' },
      { ticker: 'NVDA' },
      { currency_name: 'cad' },
    ]) {
      const { p, transport } = setup([
        { status: 'OK', results: { ...reference.results, ...patch } },
      ]);
      await expect(p.quote(stock)).rejects.toMatchObject({
        code: 'INSTRUMENT_MISMATCH',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('resolves an omitted workbook exchange from verified listing evidence without changing ledger identity', async () => {
    const imported = { ...stock, exchange: 'UNKNOWN' };
    const { p } = setup([reference, close]);
    const result = await p.quote(imported);
    expect(result.payload).toMatchObject({
      kind: 'quote',
      value: { instrument: imported, resolvedExchange: 'XNAS', last: '400' },
    });
    expect(imported.exchange).toBe('UNKNOWN');
    for (const patch of [
      { locale: 'ca' },
      { currency_name: 'cad' },
      { primary_exchange: 'XTSE' },
      { ticker: 'NVDA' },
    ]) {
      await expect(
        setup([
          { status: 'OK', results: { ...reference.results, ...patch } },
        ]).p.quote(imported),
      ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    }
  });
  it('does not price a recorded stock using an ETF with the same symbol', async () => {
    const { p, transport } = setup([
      { status: 'OK', results: { ...reference.results, type: 'ETF' } },
      close,
    ]);
    await expect(
      p.quote({ ...stock, exchange: 'UNKNOWN' }),
    ).rejects.toMatchObject({ code: 'ASSET_CLASS_MISMATCH' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('resolves an option with omitted exchange only after verifying its exact contract terms', async () => {
    const imported = { ...option, exchange: 'UNKNOWN' };
    expect(
      (
        await setup([
          optionRef,
          { ...close, symbol: optionRef.results.ticker },
        ]).p.quote(imported)
      ).payload,
    ).toMatchObject({ kind: 'quote', value: { instrument: imported } });
    await expect(
      setup([
        { status: 'OK', results: { ...optionRef.results, strike_price: 451 } },
      ]).p.quote(imported),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
  });
  it('verifies exact standard option contract and values shorts as liabilities', async () => {
    const { p } = setup([
      optionRef,
      { ...close, symbol: optionRef.results.ticker, close: 6 },
    ]);
    const result = await p.quote(option);
    expect(massiveOptionTicker(option)).toBe('O:TSLA261218C00450000');
    if (result.payload.kind !== 'quote') throw new Error('expected quote');
    const value = valuePortfolio(
      {
        accounts: [],
        cash: [],
        positions: [
          {
            accountKey: 'TFSA',
            instrument: option,
            quantity: '-1',
            averageCost: '5',
            quality: 'COMPLETE_LEDGER',
            notes: '',
          },
        ],
      },
      [result.payload.value],
      [],
      'USD',
      '2026-10-31T18:01:00Z',
    );
    expect(value.positions[0]?.marketValue).toBe('-600');
  });
  it('rejects adjusted deliverables and mismatched option terms', async () => {
    for (const patch of [
      { additional_underlyings: [{}] },
      { shares_per_contract: 10 },
      { strike_price: 451 },
      { expiration_date: '2027-12-18' },
      { underlying_ticker: 'NVDA' },
      { contract_type: 'put' },
    ]) {
      await expect(
        setup([
          { status: 'OK', results: { ...optionRef.results, ...patch } },
        ]).p.quote(option),
      ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    }
    expect(() =>
      massiveOptionTicker({ ...option, strike: '450.0001' }),
    ).toThrow('without rounding');
  });
  it('does not spend quota on missing keys, chain snapshots or unsupported FX', async () => {
    const { p, transport, gate } = setup([], '');
    await expect(p.quote(stock)).rejects.toMatchObject({
      code: 'MARKET_NOT_CONFIGURED',
    });
    await expect(p.options('TSLA', '2026-12-18')).rejects.toMatchObject({
      code: 'OPTIONS_UNAVAILABLE',
    });
    await expect(p.fx('CAD', 'USD')).rejects.toMatchObject({
      code: 'FX_UNAVAILABLE',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
  });
  it('rejects absent, mismatched and zero closes instead of making up values', async () => {
    for (const body of [
      { status: 'NOT_FOUND' },
      { ...close, close: 0 },
      { ...close, symbol: 'NVDA' },
      { ...close, from: '2026-10-31' },
    ]) {
      await expect(
        setup([reference, body]).p.quote(stock),
      ).rejects.toMatchObject({ code: 'NO_COVERAGE' });
    }
  });
  it('uses completed unadjusted hourly bars and labels mixed sessions unknown', async () => {
    const result = await setup([
      reference,
      {
        status: 'OK',
        ticker: 'TSLA',
        adjusted: false,
        results: [
          {
            t: Date.parse('2026-10-30T13:00Z'),
            o: 390,
            h: 401,
            l: 380,
            c: 400,
            v: 1000,
          },
        ],
      },
    ]).p.bars('TSLA');
    expect(result.payload).toMatchObject({
      kind: 'bars',
      value: [
        {
          session: 'UNKNOWN',
          adjustment: 'NONE',
          close: '400',
          quality: 'DELAYED',
        },
      ],
    });
    await expect(
      setup([
        reference,
        {
          status: 'OK',
          ticker: 'TSLA',
          adjusted: false,
          results: [
            { t: Date.parse('2026-10-31T14:00Z'), o: 1, h: 2, l: 1, c: 2 },
          ],
        },
      ]).p.bars('TSLA'),
    ).rejects.toMatchObject({ code: 'INVALID_MARKET_DATA' });
  });
  it('sanitizes quota and entitlement failures without retries or fallback', async () => {
    for (const [status, code] of [
      [429, 'MARKET_RATE_LIMIT'],
      [403, 'MARKET_ENTITLEMENT_REQUIRED'],
      [401, 'MARKET_ENTITLEMENT_REQUIRED'],
    ] as const) {
      const { p, transport } = setup([
        new Response('secret-reflection', { status }),
      ]);
      await expect(p.quote(stock)).rejects.toMatchObject({ code });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});
