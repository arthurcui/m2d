import { z } from 'zod';
import { Parser, parseFeed } from 'htmlparser2';
import { convert } from 'html-to-text';
import { ResearchError, symbolSchema, type Source } from './contracts.js';
import { getPublic, publicUrl, type PublicGetter } from './public-fetch.js';

export const sourceKindSchema = z.enum([
  'ir',
  'fund',
  'occ',
  'macro',
  'news',
  'analyst',
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const sourceLinkSchema = z
  .object({
    symbol: symbolSchema,
    kind: sourceKindSchema,
    name: z.string().trim().min(1).max(150),
    url: z
      .string()
      .max(2000)
      .transform((v) => publicUrl(v).href),
  })
  .strict();
export type SourceLink = z.infer<typeof sourceLinkSchema>;
export type SavedSourceLink = SourceLink & { id: string; created_at: string };
export type SourcePreset = SourceLink & {
  id: string;
  note: string;
  configured: boolean;
};
const standard = [
  {
    id: 'goldman-research',
    kind: 'analyst',
    name: 'Goldman Sachs public research',
    url: 'https://www.goldmansachs.com/insights',
    note: 'Selected public insights, not the full client research library. Browse and choose a relevant report.',
  },
  {
    id: 'morgan-research',
    kind: 'analyst',
    name: 'Morgan Stanley public research',
    url: 'https://www.morganstanley.com/insights',
    note: 'Public thematic research and commentary. Verify relevance to the selected company.',
  },

  {
    id: 'fed-calendar',
    kind: 'macro',
    name: 'Federal Reserve meeting calendar',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    note: 'Official meeting dates and statement links. Imported as a document snapshot, not scheduled alerts.',
  },
  {
    id: 'bls-calendar',
    kind: 'macro',
    name: 'BLS economic release calendar',
    url: 'https://www.bls.gov/schedule/news_release/',
    note: 'Current release schedule. Check the source timezone and later revisions; no automatic reminders.',
  },
  {
    id: 'fed-policy',
    kind: 'macro',
    name: 'Federal Reserve monetary policy',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    note: 'Official release summaries; browse links for full statements.',
  },
  {
    id: 'bls-cpi',
    kind: 'macro',
    name: 'BLS consumer price inflation',
    url: 'https://www.bls.gov/feed/cpi.rss',
    note: 'Official inflation release feed.',
  },
  {
    id: 'bls-jobs',
    kind: 'macro',
    name: 'BLS employment situation',
    url: 'https://www.bls.gov/feed/empsit.rss',
    note: 'Official employment release feed.',
  },
  {
    id: 'occ-notices',
    kind: 'occ',
    name: 'OCC options notices',
    url: 'https://infomemo.theocc.com/infomemo/search-memo',
    note: 'Market-wide directory. Browse and import the specific contract memo before interpreting an adjustment.',
  },
] as const;
export function sourcePresets(
  symbol: string,
  newsConfigured: boolean,
): SourcePreset[] {
  const rows: SourcePreset[] = standard.map((p) => ({
    ...p,
    symbol,
    configured: true,
  }));
  if (symbol === 'TSLA')
    rows.unshift({
      id: 'tesla-ir',
      symbol,
      kind: 'ir',
      name: 'Tesla investor relations',
      url: 'https://ir.tesla.com/',
      note: 'Browse shareholder decks, releases and report links. Audio webcasts are not transcribed.',
      configured: true,
    });
  if (symbol === 'TSLA')
    rows.unshift({
      id: 'tesla-q3-2026',
      symbol,
      kind: 'ir',
      name: 'Tesla Q3 2026 shareholder deck',
      url: 'https://assets-ir.tesla.com/tesla-contents/IR/TSLA-Q3-2026-Update.pdf',
      note: 'Dated public report, not an automatically updated latest-report link. Newer reports can be added by URL.',
      configured: true,
    });
  if (symbol === 'NVDA')
    rows.unshift({
      id: 'nvidia-ir',
      symbol,
      kind: 'ir',
      name: 'NVIDIA company releases',
      url: 'https://nvidianews.nvidia.com/cats/press_release.xml',
      note: 'Official issuer release feed; releases express the company’s own views.',
      configured: true,
    });
  if (['TSLL', 'TSLS'].includes(symbol))
    rows.unshift({
      id: 'direxion-tsla',
      symbol,
      kind: 'fund',
      name: 'Direxion TSLA fund documents',
      url: 'https://www.direxion.com/product/daily-tsla-bull-and-bear-leveraged-single-stock-etfs',
      note: 'Fund objectives and document links. Choose the prospectus for your exact fund.',
      configured: true,
    });
  rows.push({
    id: 'massive-news',
    symbol,
    kind: 'news',
    name: 'Company news · Massive',
    url: 'https://api.massive.com/v2/reference/news',
    note: 'Up to five publisher summaries and original links. Basic news updates hourly; not a live alert feed.',
    configured: newsConfigured,
  });
  return rows;
}
export function webMetadata(html: string, base: string) {
  let title = '',
    inTitle = false,
    link: { url: string; title: string } | null = null,
    publishedAt: string | null = null;
  const links: { url: string; title: string }[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'title') inTitle = true;
        if (
          name === 'meta' &&
          ['article:published_time', 'datePublished', 'date'].includes(
            attrs.property ?? attrs.name ?? '',
          )
        ) {
          const date = z.iso
            .datetime({ offset: true })
            .safeParse(attrs.content);
          if (date.success) publishedAt = new Date(date.data).toISOString();
        }
        if (name === 'a' && attrs.href)
          try {
            link = {
              url: publicUrl(new URL(attrs.href, base).href).href,
              title: '',
            };
          } catch {
            link = null;
          }
      },
      ontext(text) {
        if (inTitle) title += text;
        if (link) link.title += text;
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false;
        if (name === 'a' && link) {
          links.push({
            ...link,
            title: link.title.replace(/\s+/g, ' ').trim().slice(0, 180),
          });
          link = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return { title: title.trim().slice(0, 200), publishedAt, links };
}
export function feedText(raw: string): string {
  const feed = parseFeed(raw);
  if (!feed)
    throw new ResearchError(
      'INVALID_FEED',
      'This response is not a supported RSS/Atom feed.',
    );
  return [
    feed.title ?? 'Feed',
    ...feed.items
      .slice(0, 30)
      .map((item) =>
        [
          item.title ?? '',
          item.pubDate && Number.isFinite(item.pubDate.getTime())
            ? item.pubDate.toISOString()
            : 'Publication date not supplied',
          convert(item.description ?? '', { wordwrap: false }),
          item.link ?? '',
        ].join('\n'),
      ),
  ].join('\n\n');
}
export class PublicResearchSources {
  constructor(
    readonly mode: 'fixture' | 'live',
    private key = '',
    private get: PublicGetter = getPublic,
  ) {}
  get newsConfigured() {
    return this.mode === 'fixture' || !!this.key.trim();
  }
  async discover(link: SourceLink): Promise<{ url: string; title: string }[]> {
    if (this.mode === 'fixture')
      return [
        {
          url: 'https://example.com/research-report.pdf',
          title: `${link.symbol} synthetic report PDF`,
        },
      ];
    const response = await this.get(link.url),
      raw = Buffer.from(response.raw).toString('utf8');
    const feed = /xml|rss|atom/.test(response.mime) ? parseFeed(raw) : null;
    const links = feed
      ? feed.items.map((i) => ({
          url: i.link ?? '',
          title: i.title ?? 'Release',
        }))
      : webMetadata(raw, response.url).links;
    return [
      ...new Map(
        links
          .filter(
            (l) =>
              l.url !== response.url &&
              l.title &&
              (feed ||
                /\.pdf(?:\?|$)/i.test(l.url) ||
                /infomemos\?|prospectus|earnings|pressrelease|press-release|report|download|statement|shareholder|memo|holdings|fact.sheet|insight|research/i.test(
                  l.url + ' ' + l.title,
                )),
          )
          .flatMap((l) => {
            try {
              return [
                [
                  publicUrl(l.url).href,
                  { ...l, url: publicUrl(l.url).href },
                ] as const,
              ];
            } catch {
              return [];
            }
          }),
      ).values(),
    ]
      .sort(
        (a, b) =>
          Number(/\/articles\/|\.pdf(?:\?|$)/i.test(b.url)) -
          Number(/\/articles\/|\.pdf(?:\?|$)/i.test(a.url)),
      )
      .slice(0, 30);
  }
  async fetch(link: SourceLink, news = false): Promise<Source[]> {
    if (this.mode === 'fixture')
      return [
        {
          key: link.url,
          title: `${link.name} · synthetic fixture`,
          form: link.kind.toUpperCase(),
          url: link.url,
          publishedAt: null,
          mime: 'text/plain',
          raw: Buffer.from(
            `SYNTHETIC FIXTURE — not actual ${link.symbol} information. ${link.name}. Revenue outlook is unchanged. Review the original document and its limitations. This is ${link.kind} evidence, not a trading recommendation.`,
          ),
        },
      ];
    if (news) return this.news(link.symbol);
    const response = await this.get(link.url);
    const raw = Buffer.from(response.raw).toString('utf8');
    let mime: Source['mime'];
    if (Buffer.from(response.raw.slice(0, 5)).toString() === '%PDF-')
      mime = 'application/pdf';
    else if (response.mime === 'text/html') mime = 'text/html';
    else if (/xml|rss|atom/.test(response.mime)) mime = 'application/xml';
    else if (response.mime === 'text/plain' || response.mime === 'text/csv')
      mime = 'text/plain';
    else
      throw new ResearchError(
        'SOURCE_FORMAT_UNSUPPORTED',
        'Use a public HTML page, text-based PDF, plain text, CSV or RSS/Atom feed. Audio and video are not transcribed.',
      );
    const metadata =
      mime === 'text/html' ? webMetadata(raw, response.url) : null;
    if (
      metadata &&
      /access denied|just a moment|attention required|request blocked|sign in to continue/i.test(
        metadata.title,
      )
    )
      throw new ResearchError(
        'SOURCE_ACCESS_RESTRICTED',
        'This site requires browser access. Open the original and upload a permitted PDF/text copy.',
        502,
      );
    return [
      {
        key: link.url,
        title: metadata?.title || link.name,
        form: mime === 'application/xml' ? 'FEED' : link.kind.toUpperCase(),
        url: response.url,
        publishedAt: metadata?.publishedAt ?? null,
        raw: response.raw,
        mime,
      },
    ];
  }
  private async news(symbol: string): Promise<Source[]> {
    if (!this.newsConfigured)
      throw new ResearchError(
        'NEWS_NOT_CONFIGURED',
        'Configure the backend Massive key to fetch news.',
        503,
      );
    const url = `https://api.massive.com/v2/reference/news?ticker=${encodeURIComponent(symbol)}&order=desc&sort=published_utc&limit=5`;
    const response = await this.get(url, {
      Authorization: `Bearer ${this.key}`,
    });
    if (Buffer.from(response.raw).toString().includes(this.key))
      throw new ResearchError(
        'SOURCE_CREDENTIAL_ECHO',
        'The provider returned credential material; the response was not saved.',
        502,
      );
    const data = z
      .object({
        results: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              article_url: z.url(),
              published_utc: z.iso.datetime({ offset: true }),
              description: z.string().optional(),
              publisher: z.object({ name: z.string() }),
              tickers: z.array(z.string()),
            }),
          )
          .max(5),
      })
      .parse(JSON.parse(Buffer.from(response.raw).toString()));
    const rows = data.results.filter((row) => row.tickers.includes(symbol));
    if (!rows.length)
      throw new ResearchError(
        'NO_NEWS',
        'No matching news was returned. This does not establish that no relevant news exists.',
        404,
      );
    // Preserve exact response bytes as an archive; snippets are provider metadata, never full articles.
    return [
      {
        key: `massive-news:${symbol}:response`,
        title: `${symbol} · original Massive news response`,
        form: 'INDEX',
        url,
        publishedAt: null,
        raw: response.raw,
        mime: 'application/json',
      },
      ...rows.map((row) => ({
        key: `massive-news:${row.id}`,
        title: row.title.slice(0, 200),
        form: 'NEWS_SUMMARY',
        url: publicUrl(row.article_url).href,
        publishedAt: new Date(row.published_utc).toISOString(),
        raw: Buffer.from(
          `Publisher: ${row.publisher.name}\nPublished: ${row.published_utc}\n${row.title}\n\n${row.description ?? 'No summary supplied.'}\n\nProvider-supplied news summary, not the full article. Aggregator: Massive; feed updates hourly.\nOriginal: ${row.article_url}`,
        ),
        mime: 'text/plain' as const,
      })),
    ];
  }
}
