import { it, expect } from 'vitest';
import {
  evaluateStrategy,
  coverage,
  evaluateStockTrade,
  stockSizing,
  riskSummary,
  validatePlan,
  type StrategyInput,
} from '../packages/risk/src/index.js';
import {
  instrumentSchema,
  stateSchema,
  type Instrument,
} from '../packages/portfolio/src/index.js';
const stock = instrumentSchema.parse({
  assetType: 'STOCK',
  symbol: 'TEST',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
});
const option = (
  right: 'CALL' | 'PUT',
  strike = '100',
  expiry = '2027-01-15',
): Instrument => ({
  ...stock,
  assetType: 'OPTION',
  optionRight: right,
  strike,
  expiry,
  multiplier: '100',
  underlying: 'TEST',
  deliverable: 'STANDARD',
});
const account = (accountKey: string) => ({
  accountKey,
  displayName: accountKey,
  institution: 'Manual',
  accountType: 'CASH',
  baseCurrency: 'USD',
  active: true,
});
const position = (
  instrument: Instrument,
  quantity: string,
  accountKey = 'A',
) => ({
  accountKey,
  instrument,
  quantity,
  averageCost: '100',
  quality: 'BASELINE_ESTIMATE',
  notes: '',
});
const state = () =>
  stateSchema.parse({
    accounts: [account('A'), account('B')],
    positions: [position(stock, '100')],
    cash: [
      { accountKey: 'A', currency: 'USD', balance: '10000' },
      { accountKey: 'B', currency: 'USD', balance: '10000' },
    ],
  });
const input = (
  strategy: StrategyInput['strategy'],
  legs: StrategyInput['legs'],
) => ({
  version: 1,
  strategy,
  accountKey: 'A',
  legs,
  fees: '2',
  slippage: '0',
  scenarioPrices: ['0', '100', '110'],
});
it('calculates long stock, ETF and explicitly short payoff signs and fees', () => {
  const result = evaluateStrategy(
    input('STOCK', [{ instrument: stock, quantity: '10', entryPrice: '100' }]),
  );
  expect(result.maxLoss).toBe('1002');
  expect(result.unboundedProfit).toBe(true);
  expect(result.breakEven).toEqual(['100.2']);
  expect(result.scenarios[2]!.pnl).toBe('98');
  expect(
    evaluateStrategy(
      input('STOCK', [
        {
          instrument: { ...stock, assetType: 'ETF' },
          quantity: '1.5',
          entryPrice: '10.25',
        },
      ]),
    ).maxLoss,
  ).toBe('17.375');
  const short = evaluateStrategy(
    input('STOCK', [{ instrument: stock, quantity: '-10', entryPrice: '100' }]),
  );
  expect(short.unboundedLoss).toBe(true);
  expect(short.maxProfit).toBe('998');
});
it('calculates covered calls, puts and debit/credit verticals at every kink', () => {
  const call = evaluateStrategy(
    input('COVERED_CALL', [
      { instrument: stock, quantity: '100', entryPrice: '100' },
      { instrument: option('CALL', '105'), quantity: '-1', entryPrice: '2' },
    ]),
  );
  expect(call.maxProfit).toBe('698');
  expect(call.maxLoss).toBe('9802');
  expect(call.breakEven).toEqual(['98.02']);
  const put = evaluateStrategy(
    input('LONG_PUT', [
      { instrument: option('PUT'), quantity: '1', entryPrice: '3' },
    ]),
  );
  expect(put.maxProfit).toBe('9698');
  expect(put.maxLoss).toBe('302');
  const debit = evaluateStrategy(
    input('VERTICAL', [
      { instrument: option('CALL'), quantity: '1', entryPrice: '5' },
      { instrument: option('CALL', '110'), quantity: '-1', entryPrice: '2' },
    ]),
  );
  expect(debit.maxLoss).toBe('302');
  expect(debit.maxProfit).toBe('698');
  const credit = evaluateStrategy(
    input('VERTICAL', [
      { instrument: option('CALL'), quantity: '-1', entryPrice: '5' },
      { instrument: option('CALL', '110'), quantity: '1', entryPrice: '2' },
    ]),
  );
  expect(credit.maxProfit).toBe('298');
  expect(credit.maxLoss).toBe('702');
  expect(
    evaluateStrategy(
      input('CASH_SECURED_PUT', [
        { instrument: option('PUT'), quantity: '-1', entryPrice: '3' },
      ]),
    ).maxLoss,
  ).toBe('9702');
});
it('rejects unsupported combinations, fractional contracts and mismatched expiries', () => {
  expect(() =>
    evaluateStrategy(
      input('VERTICAL', [
        { instrument: option('CALL'), quantity: '1', entryPrice: '5' },
        {
          instrument: option('CALL', '110', '2027-02-19'),
          quantity: '-1',
          entryPrice: '2',
        },
      ]),
    ),
  ).toThrow();
  expect(() =>
    evaluateStrategy(
      input('LONG_CALL', [
        { instrument: option('CALL'), quantity: '0.5', entryPrice: '1' },
      ]),
    ),
  ).toThrow();
  expect(() =>
    evaluateStrategy(
      input('COVERED_CALL', [
        { instrument: stock, quantity: '99', entryPrice: '100' },
        { instrument: option('CALL'), quantity: '-1', entryPrice: '1' },
      ]),
    ),
  ).toThrow();
});
it('does not reuse shares/cash across short obligations or accounts', () => {
  const s = state();
  s.positions.push(
    ...[
      position(option('CALL'), '−1'),
      position(option('CALL', '110'), '-1'),
    ].map((p) => ({
      ...p,
      quantity: '-1',
      quality: 'BASELINE_ESTIMATE' as const,
    })),
  );
  s.positions.push({
    ...position(option('CALL'), '-1', 'B'),
    quality: 'BASELINE_ESTIMATE',
  });
  const c = coverage(s);
  expect(c.filter((r) => r.status === 'COVERED')).toHaveLength(1);
  expect(c.filter((r) => r.shortfall === '100')).toHaveLength(2);
  s.positions = [
    { ...position(option('PUT'), '-1'), quality: 'BASELINE_ESTIMATE' },
    { ...position(option('PUT', '110'), '-1'), quality: 'BASELINE_ESTIMATE' },
  ];
  expect(coverage(s).map((c) => c.shortfall)).toEqual(['0', '11000']);
});
it('analyzes sales as reduction of long holdings, not short positions or writes', () => {
  const s = state(),
    before = structuredClone(s),
    sale = evaluateStockTrade(s, {
      version: 1,
      accountKey: 'A',
      instrument: stock,
      action: 'SELL',
      quantity: '3',
      price: '200',
      fees: '1',
      stopPrice: null,
      targetPrice: null,
      riskBudget: null,
    });
  expect(sale.remaining).toBe('97');
  expect(sale.cashChange).toBe('599');
  expect(sale.realizedEstimate).toBe('299');
  expect(s).toEqual(before);
  expect(() =>
    evaluateStockTrade(s, {
      version: 1,
      accountKey: 'A',
      instrument: stock,
      action: 'SELL',
      quantity: '101',
      price: '200',
      fees: '1',
      stopPrice: null,
      targetPrice: null,
      riskBudget: null,
    }),
  ).toThrow();
  expect(stockSizing('2', '200', '190', '220', '100', '1')).toMatchObject({
    riskAtStop: '21',
    rewardAtTarget: '39',
    maxUnits: '9',
  });
  expect(() => stockSizing('2', '200', '210', null, '100', '1')).toThrow();
});
it('keeps unknown marks and Greeks unknown, not zero, and never makes stale plans actionable', () => {
  const s = state();
  s.positions.push({
    ...position(option('CALL'), '-1'),
    quality: 'BASELINE_ESTIMATE',
  });
  const summary = riskSummary(s, [], [], '2026-11-02T17:00:00Z');
  expect(summary.totals[0]!.complete).toBe(false);
  expect(summary.rows[1]!.deltaEquivalent).toBeNull();
  expect(summary.rows[1]!.scenarios[0]!.pnl).toBeNull();
  const plan = validatePlan(
    s,
    {
      version: 1,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      portfolioRevision: 1,
      analysis: input('STOCK', [
        { instrument: stock, quantity: '10', entryPrice: '100' },
      ]),
      entryCondition: 'After review',
      invalidation: 'Thesis breaks',
      target: 'At price target',
      mainRisk: 'Price gap down',
      riskBudget: '100',
      stopPrice: '90',
      targetPrice: '120',
      portfolioReviewed: true,
    },
    [],
    '2026-11-02T17:00:00Z',
  );
  expect(plan.status).toBe('WATCH_ONLY');
  expect(plan.actionable).toBe(false);
  expect(plan.reasons.join(' ')).toContain('fresh real-time');
  expect(plan.reasons.join(' ')).toContain('exceeds');
});

it('uses fresh aligned Greeks, clamps estimated option prices at zero and suppresses stale Greeks', () => {
  const now = '2026-11-02T17:00:00Z';
  const q = (
    instrument: Instrument,
    last: string,
  ): import('../packages/market/src/contracts.js').Quote => ({
    instrument,
    last,
    bid: null,
    ask: null,
    kind: 'LAST',
    provider: 'ibkr',
    sourceRecordId: 'test',
    asOf: now,
    receivedAt: now,
    availableAt: now,
    session: 'REGULAR',
    delayedMinutes: 0,
    quality: 'VALID',
    entitlement: 'test',
  });
  const s = state();
  s.positions = [
    { ...position(option('CALL'), '-1'), quality: 'BASELINE_ESTIMATE' },
  ];
  const oq = q(option('CALL'), '2'),
    underlying = q(stock, '100'),
    o = {
      quote: oq,
      delta: '0.5',
      iv: null,
      gamma: null,
      theta: null,
      vega: null,
      volume: null,
      openInterest: null,
    };
  const result = riskSummary(s, [oq, underlying], [o], now);
  expect(result.rows[0]!.deltaEquivalent).toBe('-50');
  expect(
    result.rows[0]!.scenarios.find((s) => s.shockPercent === -10)!.pnl,
  ).toBe('200');
  expect(
    result.rows[0]!.scenarios.find((s) => s.shockPercent === 10)!.pnl,
  ).toBe('-500');
  expect(
    riskSummary(s, [oq, underlying], [o], '2026-11-02T17:05:00Z').rows[0]!
      .deltaEquivalent,
  ).toBeNull();
  expect(
    riskSummary(s, [oq, underlying], [{ ...o, delta: '2' }], now).rows[0]!
      .deltaEquivalent,
  ).toBeNull();
});
it('a full stock sale plan has zero remaining price exposure, not a new short', () => {
  const s = state();
  s.positions.push({
    ...s.positions[0]!,
    instrument: option('CALL'),
    quantity: '-1',
  });
  const plan = validatePlan(
    s,
    {
      version: 1,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      portfolioRevision: 1,
      analysis: input('STOCK', [
        { instrument: stock, quantity: '100', entryPrice: '110' },
      ]),
      stockAction: 'SELL',
      entryCondition: 'Reduce exposure',
      invalidation: 'Reassess thesis',
      target: 'Close owned shares',
      mainRisk: 'Price recovers',
      riskBudget: null,
      stopPrice: null,
      targetPrice: null,
      portfolioReviewed: true,
    },
    [],
    '2026-11-02T17:00:00Z',
  );
  expect(plan.coverage[0]?.status).toBe('UNCOVERED');
  expect(plan.reasons.join(' ')).toContain('do not cover');
  expect(plan.stockTrade?.remaining).toBe('0');
  expect(plan.stockTrade?.cashChange).toBe('10998');
  expect(plan.result.maxLoss).toBe('0');
  expect(plan.result.unboundedLoss).toBe(false);
  expect(plan.result.points.every((p) => p.pnl === '0')).toBe(true);
});
