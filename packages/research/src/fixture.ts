import type { ResearchProvider, Source } from './contracts.js';
export class FixtureResearchProvider implements ResearchProvider {
  readonly id = 'fixture' as const;
  readonly configured = true;
  async fetch(symbol: string) {
    const sources: Source[] = [0, 1].map((n) => ({
      key: `${symbol}:demo-q${n + 1}`,
      title: `${symbol} synthetic quarterly report ${n + 1}`,
      form: '10-Q',
      url: null,
      publishedAt: `2026-0${n ? 8 : 5}-15T20:00:00Z`,
      mime: 'text/plain',
      raw: Buffer.from(
        `SYNTHETIC FIXTURE — not actual ${symbol} financial information.\n\nRevenue was ${n ? '120' : '100'} million USD. Management ${n ? 'increased' : 'maintained'} its revenue outlook.\n\nRisk factors: ${n ? 'Customer concentration increased; two customers represent a large share of revenue.' : 'Demand could weaken and suppliers could delay deliveries.'}\n\nOperating cash flow was ${n ? '18' : '20'} million USD. These examples do not support a trading recommendation.`,
      ),
      facts: [
        {
          metric: 'us-gaap:Revenues',
          unit: 'USD',
          start: `2026-0${n * 3 + 1}-01`,
          end: n ? '2026-06-30' : '2026-03-31',
          value: n ? '120000000' : '100000000',
          accession: `fixture-q${n + 1}`,
          filed: `2026-0${n ? 8 : 5}-15`,
        },
      ],
    }));
    return { name: `${symbol} · synthetic research`, cik: null, sources };
  }
}
