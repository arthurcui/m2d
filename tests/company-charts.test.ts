import { expect, it } from 'vitest';
import {
  financialSeries,
  displayFinancialValue,
  periodKind,
  seriesKey,
  type ChartFact,
} from '../apps/web/app/research/chart-data.js';
const fact = (v: Partial<ChartFact> = {}): ChartFact => ({
  id: 'f1',
  document_id: 'doc1',
  metric: 'us-gaap:Revenues',
  value: '12345678901234567890.12345678',
  unit: 'USD',
  period_start: '2026-01-01',
  period_end: '2026-03-31',
  filed: '2026-05-01',
  accession: 'a1',
  provider: 'sec',
  available_at: '2026-05-02T00:00:00Z',
  ...v,
});
it('separates quarterly, annual, instant and cumulative durations without deriving missing quarters', () => {
  expect(periodKind(fact())).toBe('quarter');
  expect(periodKind(fact({ period_end: '2026-06-30' }))).toBeNull();
  expect(periodKind(fact({ period_end: '2026-09-30' }))).toBeNull();
  expect(periodKind(fact({ period_end: '2026-12-31' }))).toBe('annual');
  expect(periodKind(fact({ period_start: null }))).toBe('instant');
});
it('retains exact financial values and only selects revisions known at the cutoff', () => {
  const original = fact(),
    revision = fact({
      id: 'f2',
      value: '42',
      filed: '2026-06-01',
      available_at: '2026-06-02T00:00:00Z',
    });
  expect(
    financialSeries(
      [original, revision],
      seriesKey(original),
      'quarter',
      '2026-05-03T00:00:00Z',
    ).points,
  ).toEqual([original]);
  expect(
    financialSeries([original, revision], seriesKey(original), 'quarter')
      .points,
  ).toEqual([revision]);
});
it('does not mix taxonomy tags, currencies or synthetic and real providers', () => {
  const original = fact();
  const extra = [
    fact({ unit: 'CAD' }),
    fact({ provider: 'fixture' }),
    fact({ metric: 'ifrs-full:Revenue' }),
  ];
  expect(
    financialSeries([original, ...extra], seriesKey(original), 'quarter')
      .points,
  ).toEqual([original]);
});
it('withholds conflicting same-filing values instead of picking one arbitrarily', () => {
  const original = fact();
  const r = financialSeries(
    [original, fact({ id: 'f2', value: '42' })],
    seriesKey(original),
    'quarter',
  );
  expect(r.points).toEqual([]);
  expect(r.conflicts).toBe(1);
});
it('collapses equivalent decimals and caps displayed periods explicitly', () => {
  const f = fact({ value: '42.00' });
  expect(
    financialSeries([f, fact({ value: '42' })], seriesKey(f), 'quarter')
      .conflicts,
  ).toBe(0);
  const rows = Array.from({ length: 25 }, (_, i) =>
    fact({ id: `f${i}`, period_start: null, period_end: `${2000 + i}-12-31` }),
  );
  const r = financialSeries(rows, seriesKey(f), 'instant');
  expect(r.points).toHaveLength(24);
  expect(r.omitted).toBe(1);
});

it('formats large decimal values without losing their exact digits', () => {
  expect(displayFinancialValue('-12345678901234567890.12345678')).toBe(
    '-12,345,678,901,234,567,890.12345678',
  );
  expect(displayFinancialValue('0.00')).toBe('0.00');
});
