import { Decimal } from 'decimal.js';
import { instrumentKey, type State } from '@m2d/portfolio';
import { qualityAt, type Quote, type Fx } from './contracts.js';
const D = Decimal.clone({ precision: 120 });
export function valuePortfolio(
  state: State,
  quotes: Quote[],
  fx: Fx[],
  baseCurrency: string,
  now: string,
) {
  const convert = (value: string, currency: string) => {
    if (currency === baseCurrency || new D(value).isZero())
      return { value, fx: null };
    const rate = fx
      .filter(
        (f) =>
          f.base === currency &&
          f.quote === baseCurrency &&
          Date.parse(f.asOf) <= Date.parse(now) &&
          Date.parse(f.availableAt) <= Date.parse(now),
      )
      .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
    return {
      value: rate ? new D(value).times(rate.rate).toFixed() : null,
      fx: rate ?? null,
    };
  };
  const positions = state.positions
    .filter((p) => !new D(p.quantity).isZero())
    .map((p) => {
      const quote =
        quotes
          .filter(
            (q) =>
              instrumentKey(q.instrument) === instrumentKey(p.instrument) &&
              Date.parse(q.asOf) <= Date.parse(now) &&
              Date.parse(q.availableAt) <= Date.parse(now),
          )
          .sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null;
      const midpoint =
        quote?.bid !== null &&
        quote?.bid !== undefined &&
        quote.ask !== null &&
        new D(quote.bid).gt(0) &&
        new D(quote.ask).gt(0);
      const mark = quote
        ? midpoint
          ? new D(quote.bid!).plus(quote.ask!).div(2).toFixed()
          : quote.last !== null && new D(quote.last).gt(0)
            ? quote.last
            : null
        : null;
      const marketValue =
        mark === null
          ? null
          : new D(p.quantity)
              .times(mark)
              .times(p.instrument.multiplier)
              .toFixed();
      const unrealized =
        mark === null || p.averageCost === null
          ? null
          : new D(mark)
              .minus(p.averageCost)
              .times(p.quantity)
              .times(p.instrument.multiplier)
              .toFixed();
      const converted =
        marketValue === null
          ? { value: null, fx: null }
          : convert(marketValue, p.instrument.currency);
      return {
        accountKey: p.accountKey,
        instrumentKey: instrumentKey(p.instrument),
        symbol: p.instrument.symbol,
        currency: p.instrument.currency,
        quantity: p.quantity,
        mark,
        markPolicy: midpoint ? 'MIDPOINT' : 'LAST_OR_CLOSE',
        marketValue,
        unrealized,
        costQuality: p.quality,
        baseValue: converted.value,
        fx: converted.fx,
        quote,
        quality: quote
          ? { ...qualityAt(quote, now), sourceQuality: quote.quality }
          : null,
      };
    });
  const cash = state.cash.map((c) => ({
    ...c,
    ...convert(c.balance, c.currency),
  }));
  const amounts = [
    ...positions.map((p) => p.baseValue),
    ...cash.map((c) => c.value),
  ];
  const missing = amounts.filter((v) => v === null).length;
  const evidence = [
    ...positions.flatMap((p) => [
      ...(p.quote ? [p.quote] : []),
      ...(p.fx ? [p.fx] : []),
    ]),
    ...cash.flatMap((c) => (c.fx ? [c.fx] : [])),
  ];
  const dates = evidence.map((e) => Date.parse(e.asOf));
  const knownValue = amounts
    .reduce<Decimal>((s, v) => (v === null ? s : s.plus(v)), new D(0))
    .toFixed();
  const accounts = state.accounts.map((a) => {
    const amounts = [
      ...positions
        .filter((p) => p.accountKey === a.accountKey)
        .map((p) => p.baseValue),
      ...cash.filter((c) => c.accountKey === a.accountKey).map((c) => c.value),
    ];
    const missing = amounts.filter((v) => v === null).length;
    const knownValue = amounts
      .reduce<Decimal>((sum, v) => (v === null ? sum : sum.plus(v)), new D(0))
      .toFixed();
    return {
      accountKey: a.accountKey,
      baseCurrency,
      nav: missing ? null : knownValue,
      knownValue,
      missing,
    };
  });
  return {
    version: 1 as const,
    policy: 'indicative-v1',
    computedAt: now,
    baseCurrency,
    nav: missing ? null : knownValue,
    knownValue,
    missing,
    positions,
    accounts,
    cash,
    quality: missing
      ? 'INCOMPLETE'
      : evidence.some((e) => e.quality === 'FIXTURE')
        ? 'FIXTURE'
        : evidence.some(
              (e) =>
                qualityAt(e, now).freshness !== 'FRESH' ||
                e.quality !== 'VALID' ||
                e.session !== 'REGULAR',
            )
          ? 'INDICATIVE'
          : 'CURRENT',
    oldestAsOf: dates.length
      ? new Date(Math.min(...dates)).toISOString()
      : null,
    newestAsOf: dates.length
      ? new Date(Math.max(...dates)).toISOString()
      : null,
    mixedTimestamps:
      dates.length > 1 && Math.max(...dates) - Math.min(...dates) > 120000,
    historicalPerformance: 'UNKNOWN' as const,
    preBaselineRealizedPnl: 'UNKNOWN' as const,
  };
}
export type Valuation = ReturnType<typeof valuePortfolio>;
