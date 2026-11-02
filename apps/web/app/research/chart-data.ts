export type ChartFact = {
  id: string;
  document_id: string;
  metric: string;
  value: string;
  unit: string;
  period_start: string | null;
  period_end: string;
  filed: string;
  accession: string;
  provider: string;
  available_at: string;
};
export type PeriodKind = 'quarter' | 'annual' | 'instant';
export function displayFinancialValue(value: string) {
  const [whole, fraction] = value.split('.');
  return (
    whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (fraction === undefined ? '' : `.${fraction}`)
  );
}
export function periodKind(f: ChartFact): PeriodKind | null {
  if (!f.period_start) return 'instant';
  const days =
    (Date.parse(f.period_end) - Date.parse(f.period_start)) / 86400000 + 1;
  return days >= 75 && days <= 105
    ? 'quarter'
    : days >= 330 && days <= 380
      ? 'annual'
      : null;
}
export function seriesKey(f: ChartFact) {
  return `${f.provider}|${f.metric}|${f.unit}`;
}
const normalized = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
/** Select only comparable reported periods. No YTD subtraction, currency conversion or interpolated values. */
export function financialSeries(
  facts: ChartFact[],
  key: string,
  kind: PeriodKind,
  at?: string,
) {
  const groups = new Map<string, ChartFact[]>();
  for (const f of facts) {
    if (
      seriesKey(f) !== key ||
      periodKind(f) !== kind ||
      (at && Date.parse(f.available_at) > Date.parse(at))
    )
      continue;
    const period = `${f.period_start}/${f.period_end}`;
    groups.set(period, [...(groups.get(period) ?? []), f]);
  }
  const points: ChartFact[] = [];
  let conflicts = 0;
  for (const rows of groups.values()) {
    const latest = rows.reduce((a, b) => (a.filed > b.filed ? a : b)).filed;
    const candidates = rows.filter((f) => f.filed === latest);
    if (new Set(candidates.map((f) => normalized(f.value))).size !== 1) {
      conflicts++;
      continue;
    }
    candidates.sort(
      (a, b) =>
        b.available_at.localeCompare(a.available_at) ||
        a.id.localeCompare(b.id),
    );
    points.push(candidates[0]!);
  }
  points.sort(
    (a, b) =>
      a.period_end.localeCompare(b.period_end) ||
      (a.period_start ?? '').localeCompare(b.period_start ?? ''),
  );
  return {
    points: points.slice(-24),
    conflicts,
    omitted: Math.max(0, points.length - 24),
  };
}
export function metricLabel(metric: string) {
  const labels: Record<string, string> = {
    Revenues: 'Revenue',
    Revenue: 'Revenue',
    RevenueFromContractWithCustomerExcludingAssessedTax:
      'Revenue (excluding assessed tax)',
    RevenueFromContractWithCustomerIncludingAssessedTax:
      'Revenue (including assessed tax)',
    NetIncomeLoss: 'Net income',
    ProfitLoss: 'Profit / loss',
    OperatingIncomeLoss: 'Operating income',
    NetCashProvidedByUsedInOperatingActivities: 'Operating cash flow',
    CashFlowsFromUsedInOperatingActivities: 'Operating cash flow',
    Assets: 'Assets',
    Liabilities: 'Liabilities',
    CashAndCashEquivalentsAtCarryingValue: 'Cash and equivalents',
    EarningsPerShareDiluted: 'Diluted EPS',
  };
  return labels[metric.split(':').at(-1)!] ?? metric;
}
