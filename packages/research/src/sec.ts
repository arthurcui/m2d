import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  ResearchError,
  factSchema,
  type Fact,
  type Source,
  type ResearchProvider,
} from './contracts.js';
const filingSchema = z.object({
  accessionNumber: z.array(z.string()),
  form: z.array(z.string()),
  primaryDocument: z.array(z.string()),
  acceptanceDateTime: z.array(z.string()),
  filingDate: z.array(z.string()),
});
const metricNames = new Set([
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'NetIncomeLoss',
  'OperatingIncomeLoss',
  'Assets',
  'Liabilities',
  'CashAndCashEquivalentsAtCarryingValue',
  'NetCashProvidedByUsedInOperatingActivities',
  'EarningsPerShareDiluted',
  'Revenue',
  'ProfitLoss',
  'CashFlowsFromUsedInOperatingActivities',
]);
export function xbrlFacts(raw: string): Fact[] {
  const parsed: unknown = JSON.parse(
    raw,
    (key: string, value: unknown, context?: { source: string }) =>
      key === 'val' && typeof value === 'number' && context?.source
        ? new Decimal(context.source).toFixed()
        : value,
  );
  const root = z
    .object({
      facts: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({ units: z.record(z.string(), z.array(z.unknown())) }),
        ),
      ),
    })
    .parse(parsed);
  const out: Fact[] = [];
  for (const [taxonomy, metrics] of Object.entries(root.facts))
    for (const [metric, data] of Object.entries(metrics)) {
      if (!metricNames.has(metric)) continue;
      for (const [unit, rows] of Object.entries(data.units))
        for (const row of rows) {
          const r = z
            .object({
              start: z.string().optional(),
              end: z.string(),
              val: z.union([z.string(), z.number()]),
              accn: z.string(),
              filed: z.string(),
            })
            .safeParse(row);
          if (!r.success) continue;
          const f = factSchema.safeParse({
            metric: `${taxonomy}:${metric}`,
            unit,
            start: r.data.start ?? null,
            end: r.data.end,
            value: String(r.data.val),
            accession: r.data.accn,
            filed: r.data.filed,
          });
          if (f.success) out.push(f.data);
        }
    }
  return out;
}
export class SecResearchProvider implements ResearchProvider {
  readonly id = 'sec' as const;
  readonly configured: boolean;
  private nextAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private userAgent: string,
    private fetcher: typeof fetch = fetch,
  ) {
    this.configured = /\S+@\S+\.\S+/.test(userAgent);
  }
  private async get(url: string): Promise<Uint8Array> {
    if (!this.configured)
      throw new ResearchError(
        'SEC_IDENTITY_REQUIRED',
        'Set SEC_USER_AGENT to an application name and contact email in the backend environment.',
        503,
      );
    // Only application-constructed SEC endpoints are accepted; redirects cannot escape.
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !['www.sec.gov', 'data.sec.gov'].includes(parsed.hostname)
    )
      throw new ResearchError('INVALID_SOURCE', 'Unsupported SEC source.');
    const pending = this.tail.then(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, this.nextAt - Date.now())),
      );
      this.nextAt = Date.now() + 600;
      const response = await this.fetcher(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json,text/html',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new ResearchError(
          'SEC_UNAVAILABLE',
          `SEC returned HTTP ${response.status}. Retry later; saved research is unchanged.`,
          502,
        );
      if (
        Number(response.headers.get('content-length') ?? 0) >
        12 * 1024 * 1024
      )
        throw new ResearchError(
          'DOCUMENT_TOO_LARGE',
          'SEC document exceeds 12 MiB.',
        );
      const parts: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const part of response.body) {
          size += part.byteLength;
          if (size > 12 * 1024 * 1024) {
            throw new ResearchError(
              'DOCUMENT_TOO_LARGE',
              'SEC document exceeds 12 MiB.',
            );
          }
          parts.push(part);
        }
      return Buffer.concat(parts);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async fetch(symbol: string) {
    const tickers = z
      .record(
        z.string(),
        z.object({
          cik_str: z.number().int().positive(),
          ticker: z.string(),
          title: z.string(),
        }),
      )
      .parse(
        JSON.parse(
          Buffer.from(
            await this.get('https://www.sec.gov/files/company_tickers.json'),
          ).toString(),
        ),
      );
    const company = Object.values(tickers).find(
      (t) => t.ticker === symbol || t.ticker === symbol.replace('.', '-'),
    );
    if (!company)
      throw new ResearchError(
        'ISSUER_NOT_FOUND',
        'No SEC issuer matched this ticker. Fund and non-US documents can be uploaded; no company is guessed.',
        404,
      );
    const cik = String(company.cik_str).padStart(10, '0');
    const submissionRaw = await this.get(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
    );
    const data = z
      .object({ filings: z.object({ recent: filingSchema }) })
      .parse(JSON.parse(Buffer.from(submissionRaw).toString()));
    const recent = data.filings.recent;
    const indices = recent.form
      .map((form, i) => ({ form, i }))
      .filter((r) => /^(10-[KQ]|20-F|40-F)(\/A)?$/.test(r.form))
      .slice(0, 2);
    if (!indices.length)
      throw new ResearchError(
        'NO_SUPPORTED_FILINGS',
        'No recent annual or quarterly company reports found. Upload fund or issuer documents instead.',
        404,
      );
    const sources: Source[] = [];
    for (const { form, i } of indices.reverse()) {
      const accession = recent.accessionNumber[i],
        filename = recent.primaryDocument[i];
      if (
        !accession ||
        !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
        !filename ||
        !/^[A-Za-z0-9_.-]+$/.test(filename)
      )
        throw new ResearchError(
          'SEC_INVALID_RESPONSE',
          'SEC filing identifiers were invalid.',
          502,
        );
      const url = `https://www.sec.gov/Archives/edgar/data/${company.cik_str}/${accession.replaceAll('-', '')}/${filename}`;
      const accepted = z.iso.datetime().safeParse(recent.acceptanceDateTime[i]);
      sources.push({
        key: accession,
        title: `${company.title} · ${form} · ${recent.filingDate[i]}`,
        form,
        url,
        publishedAt: accepted.success ? accepted.data : null,
        raw: await this.get(url),
        mime: 'text/html',
      });
    }
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      raw = await this.get(url);
    const facts = xbrlFacts(Buffer.from(raw).toString());
    if (facts.length)
      sources.push({
        key: `${cik}:companyfacts`,
        title: `${company.title} · XBRL financial history`,
        form: 'XBRL',
        url,
        publishedAt: null,
        raw,
        mime: 'application/json',
        facts,
      });
    // Keep the original submissions metadata with the same immutable batch.
    sources.push({
      key: `${cik}:submissions`,
      title: `${company.title} · filing index`,
      form: 'INDEX',
      url: `https://data.sec.gov/submissions/CIK${cik}.json`,
      publishedAt: null,
      raw: submissionRaw,
      mime: 'application/json',
      facts: [],
    });
    return { name: company.title, cik, sources };
  }
}
