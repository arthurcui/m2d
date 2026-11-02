import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  amount,
  nonnegative,
  positive,
  instrumentSchema,
  instrumentKey,
  type State,
} from '@m2d/portfolio';
import { qualityAt, type Quote, type OptionSnapshot } from '@m2d/market';
const D = Decimal.clone({ precision: 120 });
export const riskPolicySchema = z.object({
  concentrationPercent: z.number().positive().max(100).default(25),
  maxSpreadPercent: z.number().positive().max(100).default(5),
  nearExpiryDays: z.number().int().min(1).max(60).default(14),
});
export type RiskPolicy = z.infer<typeof riskPolicySchema>;
export const strategySchema = z.enum([
  'STOCK',
  'COVERED_CALL',
  'CASH_SECURED_PUT',
  'LONG_CALL',
  'LONG_PUT',
  'VERTICAL',
]);
export const strategyInputSchema = z
  .object({
    version: z.literal(1),
    strategy: strategySchema,
    accountKey: z.string().min(1).max(64),
    legs: z
      .array(
        z
          .object({
            instrument: instrumentSchema,
            quantity: amount.refine((v) => !new D(v).isZero()),
            entryPrice: positive,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    fees: nonnegative,
    slippage: nonnegative.nullable(),
    scenarioPrices: z.array(nonnegative).max(30).default([]),
  })
  .strict();
export type StrategyInput = z.infer<typeof strategyInputSchema>;
export class RiskError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new RiskError('UNSUPPORTED_STRATEGY', message);
}
export function evaluateStrategy(raw: unknown) {
  const input = strategyInputSchema.parse(raw),
    legs = input.legs;
  const option = legs.filter((l) => l.instrument.assetType === 'OPTION'),
    stock = legs.filter((l) => l.instrument.assetType !== 'OPTION');
  const symbol = legs[0]!.instrument.underlying ?? legs[0]!.instrument.symbol,
    currency = legs[0]!.instrument.currency;
  if (
    legs.some(
      (l) =>
        (l.instrument.underlying ?? l.instrument.symbol) !== symbol ||
        l.instrument.currency !== currency,
    )
  )
    fail('All legs must use the same underlying and currency.');
  if (option.some((l) => !new D(l.quantity).isInteger()))
    fail('Option quantities must be whole contracts.');
  if (input.strategy === 'STOCK' && (stock.length !== 1 || option.length))
    fail('Stock/ETF analysis requires one equity leg.');
  if (
    input.strategy === 'COVERED_CALL' &&
    (stock.length !== 1 ||
      option.length !== 1 ||
      option[0]!.instrument.optionRight !== 'CALL' ||
      new D(option[0]!.quantity).gte(0) ||
      !new D(stock[0]!.quantity).eq(new D(option[0]!.quantity).abs().mul(100)))
  )
    fail(
      'A covered-call payoff needs exactly 100 long shares per short standard call. Portfolio coverage is checked separately.',
    );
  if (
    input.strategy === 'CASH_SECURED_PUT' &&
    (legs.length !== 1 ||
      option.length !== 1 ||
      option[0]!.instrument.optionRight !== 'PUT' ||
      new D(option[0]!.quantity).gte(0))
  )
    fail('A cash-secured put requires one short put leg.');
  if (
    ['LONG_CALL', 'LONG_PUT'].includes(input.strategy) &&
    (legs.length !== 1 ||
      option.length !== 1 ||
      new D(option[0]!.quantity).lte(0) ||
      option[0]!.instrument.optionRight !==
        (input.strategy === 'LONG_CALL' ? 'CALL' : 'PUT'))
  )
    fail('Choose one positive-quantity option of the selected type.');
  if (
    input.strategy === 'VERTICAL' &&
    (option.length !== 2 ||
      option[0]!.instrument.optionRight !== option[1]!.instrument.optionRight ||
      option[0]!.instrument.expiry !== option[1]!.instrument.expiry ||
      option[0]!.instrument.strike === option[1]!.instrument.strike ||
      !new D(option[0]!.quantity).plus(option[1]!.quantity).isZero())
  )
    fail(
      'A vertical requires equal opposite quantities, same right/expiry, and distinct strikes.',
    );
  const costs = new D(input.fees).plus(input.slippage ?? 0);
  const entry = legs.reduce(
    (s, l) =>
      s.plus(new D(l.quantity).mul(l.instrument.multiplier).mul(l.entryPrice)),
    new D(0),
  );
  const payoff = (price: Decimal) =>
    legs
      .reduce((sum, l) => {
        const i = l.instrument;
        const intrinsic =
          i.assetType === 'OPTION'
            ? D.max(
                0,
                i.optionRight === 'CALL'
                  ? price.minus(i.strike!)
                  : new D(i.strike!).minus(price),
              )
            : price;
        return sum.plus(intrinsic.mul(l.quantity).mul(i.multiplier));
      }, new D(0))
      .minus(entry)
      .minus(costs);
  const knots = [new D(0), ...option.map((l) => new D(l.instrument.strike!))]
    .sort((a, b) => a.cmp(b))
    .filter((v, i, a) => !i || !v.eq(a[i - 1]!));
  const last = knots.at(-1)!,
    slope = payoff(last.plus(1)).minus(payoff(last));
  const values = knots.map(payoff),
    min = D.min(...values),
    max = D.max(...values);
  const roots: string[] = [];
  for (let i = 0; i < knots.length; i++) {
    const x = knots[i]!,
      y = payoff(x),
      next = knots[i + 1] ?? x.plus(1),
      gradient = payoff(next).minus(y).div(next.minus(x));
    if (y.isZero()) roots.push(x.toFixed());
    if (!gradient.isZero()) {
      const r = x.minus(y.div(gradient));
      if (r.gte(x) && (!knots[i + 1] || r.lte(next))) roots.push(r.toFixed());
    }
  }
  const reference = stock[0]
    ? new D(stock[0].entryPrice)
    : new D(option[0]!.instrument.strike!);
  const high = D.max(reference.mul(2), last.mul(1.5), 1);
  const prices = [
    ...Array.from({ length: 41 }, (_, i) => high.mul(i).div(40)),
    ...knots,
    ...input.scenarioPrices.map((v) => new D(v)),
  ]
    .sort((a, b) => a.cmp(b))
    .filter((v, i, a) => !i || !v.eq(a[i - 1]!));
  return {
    version: 1 as const,
    policy: 'payoff-expiry-v1',
    strategy: input.strategy,
    symbol,
    currency,
    expiry: option[0]?.instrument.expiry ?? null,
    entryDebit: entry.toFixed(),
    estimatedCosts: costs.toFixed(),
    costsComplete: input.slippage !== null,
    maxProfit: slope.gt(0) ? null : D.max(0, max).toFixed(),
    maxLoss: slope.lt(0) ? null : D.max(0, min.neg()).toFixed(),
    unboundedProfit: slope.gt(0),
    unboundedLoss: slope.lt(0),
    breakEven: [...new Set(roots)],
    points: prices.map((price) => ({
      price: price.toFixed(),
      pnl: payoff(price).toFixed(),
    })),
    scenarios: input.scenarioPrices.map((v) => ({
      price: v,
      pnl: payoff(new D(v)).toFixed(),
    })),
    limitations: [
      'Hypothetical payoff, not an order or expected return.',
      'Option values are at expiry; early assignment, dividends, financing and path-dependent exercise are not modeled.',
      ...(input.slippage === null
        ? ['Slippage is unknown and excluded; results are incomplete.']
        : []),
    ],
  };
}
export type StrategyResult = ReturnType<typeof evaluateStrategy>;
export const planInputSchema = z
  .object({
    version: z.literal(1),
    idempotencyKey: z.uuid(),
    portfolioRevision: z.number().int().nonnegative(),
    analysis: strategyInputSchema,
    stockAction: z.enum(['BUY', 'SELL']).default('BUY'),
    entryCondition: z.string().trim().min(3).max(1000),
    invalidation: z.string().trim().min(3).max(1000),
    target: z.string().trim().min(3).max(1000),
    mainRisk: z.string().trim().min(3).max(1000),
    riskBudget: positive.nullable(),
    stopPrice: positive.nullable(),
    targetPrice: positive.nullable(),
    portfolioReviewed: z.boolean(),
  })
  .strict();
export type PlanInput = z.infer<typeof planInputSchema>;
export const planDraftSchema = planInputSchema.omit({
  idempotencyKey: true,
  portfolioRevision: true,
});
export function stockSizing(
  quantity: string,
  entry: string,
  stop: string | null,
  target: string | null,
  budget: string | null,
  fees: string,
) {
  const q = new D(quantity),
    price = new D(entry);
  if (stop === null)
    return {
      riskAtStop: null,
      rewardAtTarget: null,
      maxUnits: null,
      reason:
        'A stop/invalidation price is required for sizing; gaps can exceed stop-based risk.',
    };
  const lossPerUnit = q.gt(0) ? price.minus(stop) : new D(stop).minus(price);
  if (lossPerUnit.lte(0))
    throw new RiskError(
      'INVALID_STOP',
      'For a long buy the stop must be below entry; for short exposure it must be above entry.',
    );
  if (
    target !== null &&
    (q.gt(0) ? new D(target).lte(price) : new D(target).gte(price))
  )
    throw new RiskError(
      'INVALID_TARGET',
      'The target must be on the profit side of entry.',
    );
  return {
    riskAtStop: lossPerUnit.mul(q.abs()).plus(fees).toFixed(),
    rewardAtTarget:
      target === null
        ? null
        : (q.gt(0) ? new D(target).minus(price) : price.minus(target))
            .mul(q.abs())
            .minus(fees)
            .toFixed(),
    maxUnits:
      budget === null
        ? null
        : D.max(
            0,
            new D(budget).minus(fees).div(lossPerUnit).floor(),
          ).toFixed(),
    reason:
      'Sizing is based on a hypothetical stop fill; gaps and execution slippage can exceed this loss.',
  };
}
export function coverage(state: State) {
  const shares = new Map<string, Decimal>(),
    cash = new Map<string, Decimal>();
  const key = (account: string, symbol: string, currency: string) =>
    `${account}|${symbol}|${currency}`;
  for (const p of state.positions)
    if (p.instrument.assetType !== 'OPTION') {
      const k = key(p.accountKey, p.instrument.symbol, p.instrument.currency);
      shares.set(k, (shares.get(k) ?? new D(0)).plus(p.quantity));
    }
  for (const c of state.cash)
    cash.set(`${c.accountKey}|${c.currency}`, new D(c.balance));
  return state.positions
    .filter(
      (p) => p.instrument.assetType === 'OPTION' && new D(p.quantity).lt(0),
    )
    .sort((a, b) =>
      (a.instrument.expiry! + instrumentKey(a.instrument)).localeCompare(
        b.instrument.expiry! + instrumentKey(b.instrument),
      ),
    )
    .map((p) => {
      const i = p.instrument,
        units = new D(p.quantity).abs().mul(i.multiplier),
        call = i.optionRight === 'CALL';
      const k = call
          ? key(p.accountKey, i.underlying!, i.currency)
          : `${p.accountKey}|${i.currency}`,
        pool = call ? shares : cash,
        required = call ? units : units.mul(i.strike!),
        available = D.max(0, pool.get(k) ?? 0),
        allocated = D.min(required, available);
      pool.set(k, available.minus(allocated));
      return {
        accountKey: p.accountKey,
        instrumentKey: instrumentKey(i),
        symbol: i.underlying!,
        expiry: i.expiry!,
        currency: i.currency,
        kind: call ? 'SHARE_COVERAGE' : 'CASH_COLLATERAL',
        required: required.toFixed(),
        allocated: allocated.toFixed(),
        shortfall: required.minus(allocated).toFixed(),
        status: allocated.eq(required) ? 'COVERED' : 'UNCOVERED',
        notice:
          'Same-account allocation, earliest expiry first; resources cannot cover multiple obligations. Long options are not counted as shares/cash. Not broker buying power.',
      };
    });
}

export function riskSummary(
  state: State,
  quotes: Quote[],
  options: OptionSnapshot[],
  now: string,
  policy: RiskPolicy = riskPolicySchema.parse({}),
) {
  const matched = (instrument: State['positions'][number]['instrument']) =>
    quotes
      .filter(
        (q) =>
          instrumentKey(q.instrument) === instrumentKey(instrument) &&
          q.availableAt <= now &&
          q.asOf <= now,
      )
      .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  const rows = state.positions
    .filter((p) => !new D(p.quantity).isZero())
    .map((p) => {
      const i = p.instrument,
        q = matched(i),
        quality = q ? qualityAt(q, now) : null;
      const mark = q
        ? q.bid !== null && q.ask !== null && new D(q.bid).gt(0)
          ? new D(q.bid).plus(q.ask).div(2).toFixed()
          : q.last
        : null;
      const option = options.find(
        (o) =>
          instrumentKey(o.quote.instrument) === instrumentKey(i) &&
          o.quote.asOf === q?.asOf &&
          o.quote.availableAt <= now &&
          o.quote.quality === 'VALID',
      );
      const usable =
        !!q &&
        q.quality === 'VALID' &&
        q.delayedMinutes === 0 &&
        q.session === 'REGULAR' &&
        quality?.freshness === 'FRESH';
      const delta =
        i.assetType !== 'OPTION'
          ? '1'
          : usable &&
              option?.delta !== null &&
              option?.delta !== undefined &&
              new D(option.delta).gte(i.optionRight === 'CALL' ? 0 : -1) &&
              new D(option.delta).lte(i.optionRight === 'CALL' ? 1 : 0)
            ? option.delta
            : null;
      const underlying = quotes
        .filter(
          (u) =>
            u.instrument.assetType !== 'OPTION' &&
            u.instrument.symbol === i.underlying &&
            u.instrument.currency === i.currency &&
            u.quality === 'VALID' &&
            u.availableAt <= now &&
            qualityAt(u, now).freshness === 'FRESH',
        )
        .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
      const underlyingMark = underlying?.last ?? null;
      const equivalent =
        delta === null
          ? null
          : new D(p.quantity).mul(i.multiplier).mul(delta).toFixed();
      const value =
        mark === null
          ? null
          : new D(p.quantity).mul(i.multiplier).mul(mark).toFixed();
      return {
        accountKey: p.accountKey,
        instrumentKey: instrumentKey(i),
        symbol: i.underlying ?? i.symbol,
        assetType: i.assetType,
        currency: i.currency,
        quantity: p.quantity,
        mark,
        value,
        grossValue: value === null ? null : new D(value).abs().toFixed(),
        deltaEquivalent: equivalent,
        expiry: i.expiry,
        daysToExpiry:
          i.expiry === null
            ? null
            : Math.ceil(
                (Date.parse(i.expiry + 'T00:00:00Z') -
                  Date.parse(
                    new Intl.DateTimeFormat('en-CA', {
                      timeZone: 'America/New_York',
                    }).format(new Date(now)) + 'T00:00:00Z',
                  )) /
                  86400000,
              ),
        shortOptionNotional:
          i.assetType === 'OPTION' && new D(p.quantity).lt(0)
            ? new D(p.quantity).abs().mul(i.multiplier).mul(i.strike!).toFixed()
            : null,
        quote: q ?? null,
        quality,
        scenarios: [-20, -10, -5, 5, 10, 20].map((shock) => ({
          shockPercent: shock,
          pnl:
            i.assetType !== 'OPTION' && mark !== null
              ? new D(p.quantity).mul(mark).mul(shock).div(100).toFixed()
              : delta !== null && underlyingMark !== null && mark !== null
                ? D.max(
                    0,
                    new D(mark).plus(
                      new D(underlyingMark).mul(shock).div(100).mul(delta),
                    ),
                  )
                    .minus(mark)
                    .mul(p.quantity)
                    .mul(i.multiplier)
                    .toFixed()
                : null,
          method:
            i.assetType === 'OPTION'
              ? 'First-order delta estimate with option-price floor at zero; constant volatility/time, unreliable for large moves and near expiry. Not expiry payoff.'
              : 'Linear stock/ETF price shock; distributions and fees excluded',
        })),
      };
    });
  const currencies = [
    ...new Set([
      ...rows.map((r) => r.currency),
      ...state.cash.map((c) => c.currency),
    ]),
  ];
  const totals = currencies.map((currency) => {
    const relevant = rows.filter((r) => r.currency === currency),
      gross = relevant.reduce((s, r) => s.plus(r.grossValue ?? 0), new D(0));
    return {
      currency,
      knownGrossExposure: gross.toFixed(),
      complete: relevant.every((r) => r.value !== null),
      cash: state.cash
        .filter((c) => c.currency === currency)
        .reduce((s, c) => s.plus(c.balance), new D(0))
        .toFixed(),
      symbols: [...new Set(relevant.map((r) => r.symbol))].map((symbol) => {
        const value = relevant
          .filter((r) => r.symbol === symbol)
          .reduce((s, r) => s.plus(r.grossValue ?? 0), new D(0));
        return {
          symbol,
          knownGross: value.toFixed(),
          netDeltaEquivalent: relevant
            .filter((r) => r.symbol === symbol)
            .some((r) => r.deltaEquivalent === null)
            ? null
            : relevant
                .filter((r) => r.symbol === symbol)
                .reduce((v, r) => v.plus(r.deltaEquivalent ?? 0), new D(0))
                .toFixed(),
          percentOfKnownGross: gross.isZero()
            ? null
            : value.div(gross).mul(100).toFixed(2),
          concentrated:
            !gross.isZero() &&
            value.div(gross).mul(100).gt(policy.concentrationPercent),
        };
      }),
    };
  });
  return {
    version: 1 as const,
    policy: 'portfolio-risk-v1',
    thresholds: policy,
    asOf: now,
    rows,
    totals,
    coverage: coverage(state),
    accounts: state.accounts.map((a) => ({
      accountKey: a.accountKey,
      currencies: [
        ...new Set(
          rows
            .filter((r) => r.accountKey === a.accountKey)
            .map((r) => r.currency),
        ),
      ].map((currency) => {
        const selected = rows.filter(
          (r) => r.accountKey === a.accountKey && r.currency === currency,
        );
        return {
          currency,
          knownGross: selected
            .reduce((v, r) => v.plus(r.grossValue ?? 0), new D(0))
            .toFixed(),
          complete: selected.every((r) => r.value !== null),
          scenarios: [-20, -10, -5, 5, 10, 20].map((shock) => {
            const values = selected.map(
              (r) =>
                r.scenarios.find((s) => s.shockPercent === shock)?.pnl ?? null,
            );
            return {
              shockPercent: shock,
              pnl: values.some((v) => v === null)
                ? null
                : values
                    .reduce<Decimal>((v, p) => v.plus(p ?? 0), new D(0))
                    .toFixed(),
            };
          }),
        };
      }),
    })),
    limitations: [
      'Self-reported holdings; not broker verified.',
      'Native-currency groups are not added together; FX risk is not currency trading.',
      'Sector, correlated-group and event-calendar coverage is unknown unless separately supplied.',
      'Missing/stale Greeks are not treated as zero. Option stress P&L uses a labelled first-order delta approximation only with fresh aligned option and underlying inputs; otherwise unknown.',
      `Concentration uses a ${policy.concentrationPercent}% screening threshold on known gross marked exposure, not a recommendation.`,
    ],
  };
}

export const stockTradeSchema = z
  .object({
    version: z.literal(1),
    accountKey: z.string().min(1).max(64),
    instrument: instrumentSchema.refine((i) => i.assetType !== 'OPTION'),
    action: z.enum(['BUY', 'SELL']),
    quantity: positive,
    price: positive,
    fees: nonnegative,
    stopPrice: positive.nullable(),
    targetPrice: positive.nullable(),
    riskBudget: positive.nullable(),
  })
  .strict();
export function evaluateStockTrade(state: State, raw: unknown) {
  const input = stockTradeSchema.parse(raw),
    current = state.positions.find(
      (p) =>
        p.accountKey === input.accountKey &&
        instrumentKey(p.instrument) === instrumentKey(input.instrument),
    );
  if (
    !state.accounts.some((a) => a.active && a.accountKey === input.accountKey)
  )
    throw new RiskError('ACCOUNT_NOT_FOUND', 'Select an active account.');
  const held = new D(current?.quantity ?? 0),
    q = new D(input.quantity),
    sell = input.action === 'SELL';
  if (sell && q.gt(D.max(held, 0)))
    throw new RiskError(
      'INSUFFICIENT_SHARES',
      'This sale exceeds recorded long shares; short selling is not silently substituted.',
    );
  const cash =
    state.cash.find(
      (c) =>
        c.accountKey === input.accountKey &&
        c.currency === input.instrument.currency,
    )?.balance ?? null;
  const cashChange = q
      .mul(input.price)
      .mul(sell ? 1 : -1)
      .minus(input.fees),
    remaining = held.plus(q.mul(sell ? -1 : 1));
  return {
    kind: 'HYPOTHETICAL_STOCK_TRADE',
    ...input,
    held: held.toFixed(),
    remaining: remaining.toFixed(),
    cashChange: cashChange.toFixed(),
    cashAfter: cash === null ? null : new D(cash).plus(cashChange).toFixed(),
    cashSufficient: cash !== null && new D(cash).plus(cashChange).gte(0),
    sizing: sell
      ? null
      : stockSizing(
          input.quantity,
          input.price,
          input.stopPrice,
          input.targetPrice,
          input.riskBudget,
          input.fees,
        ),
    realizedEstimate:
      sell &&
      current?.averageCost !== null &&
      current?.averageCost !== undefined
        ? q
            .mul(new D(input.price).minus(current.averageCost))
            .minus(input.fees)
            .toFixed()
        : null,
    costQuality: current?.quality ?? 'UNKNOWN',
    scenarios: [-20, -10, -5, 5, 10, 20].map((shock) => ({
      shockPercent: shock,
      before: held.mul(input.price).mul(shock).div(100).toFixed(),
      after: remaining.mul(input.price).mul(shock).div(100).toFixed(),
    })),
    notice:
      'Hypothetical trade only; no holdings or cash changed. Sale profit is an estimate from recorded unit cost, not tax cost basis. Gaps, fees and slippage can exceed stop-based risk.',
  };
}
export function validatePlan(
  state: State,
  raw: unknown,
  quotes: Quote[],
  now: string,
  policy: RiskPolicy = riskPolicySchema.parse({}),
) {
  const input = planInputSchema.parse(raw),
    reasons: string[] = [];
  let result = evaluateStrategy(input.analysis);
  const stockTrade =
    input.analysis.strategy === 'STOCK'
      ? evaluateStockTrade(state, {
          version: 1,
          accountKey: input.analysis.accountKey,
          instrument: input.analysis.legs[0]!.instrument,
          action: input.stockAction,
          quantity: input.analysis.legs[0]!.quantity,
          price: input.analysis.legs[0]!.entryPrice,
          fees: input.analysis.fees,
          stopPrice: input.stopPrice,
          targetPrice: input.targetPrice,
          riskBudget: input.riskBudget,
        })
      : null;
  if (stockTrade?.action === 'SELL') {
    result = new D(stockTrade.remaining).isZero()
      ? {
          ...result,
          maxLoss: '0',
          maxProfit: '0',
          unboundedLoss: false,
          unboundedProfit: false,
          breakEven: [],
          points: result.points.map((p) => ({ ...p, pnl: '0' })),
          scenarios: [],
          entryDebit: '0',
          estimatedCosts: '0',
        }
      : evaluateStrategy({
          ...input.analysis,
          legs: [
            { ...input.analysis.legs[0]!, quantity: stockTrade.remaining },
          ],
          fees: '0',
          slippage: '0',
        });
    result.limitations.push(
      'Chart shows remaining shares at the sale reference price; sale cash flow and cost-based profit estimate are reported separately.',
    );
  }
  const account = state.accounts.find(
    (a) => a.accountKey === input.analysis.accountKey && a.active,
  );
  if (!account)
    throw new RiskError('ACCOUNT_NOT_FOUND', 'Select an active account.');
  if (!input.portfolioReviewed)
    reasons.push(
      'Confirm that current self-reported holdings and cash are up to date.',
    );
  if (!result.costsComplete) reasons.push('Slippage is unknown.');
  if (result.unboundedLoss)
    reasons.push('Unbounded loss; no automatic sizing.');
  const evidence = input.analysis.legs.map(
    (l) =>
      quotes
        .filter(
          (q) =>
            instrumentKey(q.instrument) === instrumentKey(l.instrument) &&
            q.asOf <= now &&
            q.availableAt <= now,
        )
        .sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null,
  );
  evidence.forEach((q, i) => {
    if (
      !q ||
      q.quality !== 'VALID' ||
      qualityAt(q, now).freshness !== 'FRESH' ||
      q.session !== 'REGULAR' ||
      q.kind !== 'LAST' ||
      q.delayedMinutes !== 0
    )
      reasons.push(
        `Leg ${i + 1}: fresh real-time regular-session evidence is unavailable.`,
      );
    if (
      !q ||
      q.bid === null ||
      q.ask === null ||
      new D(q.bid).lte(0) ||
      new D(q.ask).minus(q.bid).div(q.ask).mul(100).gt(policy.maxSpreadPercent)
    )
      reasons.push(
        `Leg ${i + 1}: usable bid/ask liquidity is unavailable or spread exceeds ${policy.maxSpreadPercent}%.`,
      );
  });
  const proposed: State = structuredClone(state);
  if (stockTrade) {
    const leg = input.analysis.legs[0]!;
    const held = proposed.positions.find(
      (p) =>
        p.accountKey === input.analysis.accountKey &&
        instrumentKey(p.instrument) === instrumentKey(leg.instrument),
    );
    if (held) held.quantity = stockTrade.remaining;
    else
      proposed.positions.push({
        accountKey: input.analysis.accountKey,
        instrument: leg.instrument,
        quantity: stockTrade.remaining,
        averageCost: null,
        quality: 'UNKNOWN',
        notes: '',
      });
  }
  // Proposed option obligations are added to current holdings for resource checks.
  for (const l of input.analysis.legs.filter(
    (l) => l.instrument.assetType === 'OPTION',
  )) {
    const found = proposed.positions.find(
      (p) =>
        p.accountKey === input.analysis.accountKey &&
        instrumentKey(p.instrument) === instrumentKey(l.instrument),
    );
    if (found)
      found.quantity = new D(found.quantity).plus(l.quantity).toFixed();
    else
      proposed.positions.push({
        accountKey: input.analysis.accountKey,
        instrument: l.instrument,
        quantity: l.quantity,
        averageCost: null,
        quality: 'UNKNOWN',
        notes: '',
      });
  }
  const debitLegs =
    input.analysis.strategy === 'COVERED_CALL'
      ? input.analysis.legs.filter((l) => l.instrument.assetType === 'OPTION')
      : input.analysis.legs;
  const cashNeeded = D.max(
    0,
    debitLegs
      .reduce(
        (v, l) =>
          v.plus(
            new D(l.entryPrice).mul(l.quantity).mul(l.instrument.multiplier),
          ),
        new D(0),
      )
      .plus(input.analysis.fees)
      .plus(input.analysis.slippage ?? 0),
  );
  const proposedCash = proposed.cash.find(
    (c) =>
      c.accountKey === account.accountKey && c.currency === result.currency,
  );
  if (proposedCash && stockTrade?.action !== 'SELL')
    proposedCash.balance = new D(proposedCash.balance)
      .minus(cashNeeded)
      .toFixed();
  const obligations = coverage(proposed).filter(
    (c) => c.accountKey === input.analysis.accountKey,
  );
  if (obligations.some((c) => c.status === 'UNCOVERED'))
    reasons.push(
      'Recorded account resources do not cover all proposed and existing obligations.',
    );
  const stock = input.analysis.legs.find(
    (l) => l.instrument.assetType !== 'OPTION',
  );
  const sizing =
    stock && stockTrade?.action !== 'SELL'
      ? stockSizing(
          stock.quantity,
          stock.entryPrice,
          input.stopPrice,
          input.targetPrice,
          input.riskBudget,
          result.estimatedCosts,
        )
      : null;
  if (stock && stockTrade?.action !== 'SELL' && input.stopPrice === null)
    reasons.push('Stock sizing needs an explicit stop/invalidation price.');
  if (input.riskBudget === null) reasons.push('A risk budget is not supplied.');
  const risk = sizing?.riskAtStop ?? result.maxLoss;
  if (
    risk !== null &&
    input.riskBudget !== null &&
    new D(risk).gt(input.riskBudget)
  )
    reasons.push('Proposed risk exceeds the supplied budget.');
  const cash = state.cash.find(
    (c) =>
      c.accountKey === account.accountKey && c.currency === result.currency,
  )?.balance;
  if (
    stockTrade?.action !== 'SELL' &&
    (cash === undefined || new D(cash).lt(cashNeeded))
  )
    reasons.push(
      'Insufficient or unknown cash for the hypothetical debit and costs.',
    );
  if (
    input.analysis.legs.some(
      (l) =>
        l.instrument.expiry !== null && l.instrument.expiry < now.slice(0, 10),
    )
  )
    reasons.push('An option expiry is already in the past.');
  reasons.push(
    'Account permissions, event-calendar risks and execution conditions require manual verification.',
  );
  return {
    version: 1 as const,
    policy: 'trade-plan-v1',
    thresholds: policy,
    status: 'WATCH_ONLY' as const,
    actionable: false,
    asOf: now,
    input,
    result,
    sizing,
    stockTrade,
    coverage: obligations,
    evidence,
    reasons,
    mainRisk: input.mainRisk,
    exit: input.target,
    invalidation: input.invalidation,
    notice:
      'A saved hypothetical plan is not an order or a portfolio change. No automatic trigger/monitoring in M5.',
  };
}

export function baseExposure(valuation: {
  baseCurrency: string;
  positions: Array<{
    accountKey: string;
    symbol: string;
    baseValue: string | null;
  }>;
}) {
  const aggregate = (rows: typeof valuation.positions) => ({
    complete: rows.every((r) => r.baseValue !== null),
    knownNet: rows
      .reduce((v, r) => v.plus(r.baseValue ?? 0), new D(0))
      .toFixed(),
    knownGross: rows
      .reduce((v, r) => v.plus(new D(r.baseValue ?? 0).abs()), new D(0))
      .toFixed(),
  });
  return {
    currency: valuation.baseCurrency,
    ...aggregate(valuation.positions),
    accounts: [...new Set(valuation.positions.map((r) => r.accountKey))].map(
      (accountKey) => ({
        accountKey,
        ...aggregate(
          valuation.positions.filter((r) => r.accountKey === accountKey),
        ),
      }),
    ),
    notice:
      'Converted using preserved market FX evidence; missing FX or prices leave totals incomplete. This is exposure reporting, not foreign-exchange trading.',
  };
}
