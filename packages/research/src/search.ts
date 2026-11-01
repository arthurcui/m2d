import { z } from 'zod';
import { lookupSchema } from './contracts.js';

/** Shared by the search screen and Agent. Dates filter evidence, never model knowledge. */
export const evidenceSearchSchema = lookupSchema
  .extend({
    query: z.string().trim().min(1).max(500),
    mode: z
      .enum(['hybrid', 'keyword', 'semantic'])
      .optional()
      .describe(
        'Omit/null uses the available search method. Set only when the user explicitly requests a method.',
      ),
    forms: z
      .array(z.string().trim().toUpperCase().min(1).max(30))
      .max(8)
      .optional()
      .describe(
        'Omit/null includes all forms, including uploaded REPORT documents. Filter only on explicitly requested forms.',
      ),
    source: z
      .enum([
        'sec',
        'upload',
        'fixture',
        'ir',
        'fund',
        'occ',
        'macro',
        'news',
        'analyst',
      ])
      .optional()
      .describe(
        'Omit/null includes all sources. A financial question does not imply SEC-only; uploaded reports are also evidence.',
      ),
    publishedFrom: z.iso
      .date()
      .optional()
      .describe(
        'Omit/null unless the user requests a publication-date range. A forecast horizon is not a publication-date filter.',
      ),
    publishedTo: z.iso
      .date()
      .optional()
      .describe(
        'Omit/null unless the user requests a publication-date range. Do not invent a current-year range.',
      ),
    revisions: z.enum(['latest', 'all']).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.publishedFrom || !v.publishedTo || v.publishedFrom <= v.publishedTo,
    {
      message: 'Publication start must be on or before the end date.',
    },
  );
export type EvidenceSearch = z.infer<typeof evidenceSearchSchema>;
export const factQuerySchema = lookupSchema
  .extend({
    metric: z.string().trim().min(1).max(150).optional(),
    unit: z.string().trim().min(1).max(60).optional(),
    periodFrom: z.iso.date().optional(),
    periodTo: z.iso.date().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const passageSchema = z
  .object({
    documentId: z.uuid(),
    chunkIndex: z.number().int().nonnegative(),
    at: z.iso.datetime().optional(),
  })
  .strict();
export type SearchPassage = {
  document_id: string;
  chunk_index: number;
  page: number | null;
  text: string;
  symbol: string;
  title: string;
  form: string;
  provider: string;
  revision: number;
  url: string | null;
  published_at: string | null;
  available_at: string;
  hash: string;
};
export type SearchHit = SearchPassage & {
  score: number;
  matches: ('keyword' | 'semantic')[];
  keywordRank: number | null;
  semanticRank: number | null;
  similarity: number | null;
  citation: string;
};
export type IndexCoverage = { total: number; indexed: number; pending: number };
export type SearchResponse = {
  version: 2;
  symbol: string;
  query: string;
  at: string;
  mode: 'hybrid' | 'keyword' | 'semantic';
  ranking: 'rrf-v1';
  hits: SearchHit[];
  coverage: IndexCoverage;
  warnings: string[];
  embedding: { provider: string; model: string; cached: boolean } | null;
};

/** Reciprocal rank fusion avoids comparing unrelated FTS and cosine score scales. */
export function rankEvidence(
  lexical: SearchPassage[],
  semantic: (SearchPassage & { similarity: number })[],
  limit = 12,
): SearchHit[] {
  const candidates = new Map<string, SearchHit>();
  for (const [method, rows] of [
    ['keyword', lexical],
    ['semantic', semantic],
  ] as const) {
    rows.forEach((row, i) => {
      const key = `${row.document_id}:${row.chunk_index}`;
      const hit: SearchHit = candidates.get(key) ?? {
        ...row,
        score: 0,
        matches: [],
        keywordRank: null,
        semanticRank: null,
        similarity: null,
        citation: `/research?document=${row.document_id}#chunk-${row.chunk_index}`,
      };
      hit.score += 1 / (60 + i + 1);
      hit.matches.push(method);
      if (method === 'keyword') hit.keywordRank = i + 1;
      else {
        hit.semanticRank = i + 1;
        hit.similarity = (
          row as SearchPassage & { similarity: number }
        ).similarity;
      }
      candidates.set(key, hit);
    });
  }
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.available_at.localeCompare(a.available_at) ||
      a.document_id.localeCompare(b.document_id) ||
      a.chunk_index - b.chunk_index,
  );
  const seen = new Set<string>(),
    counts = new Map<string, number>(),
    selected: SearchHit[] = [],
    overflow: SearchHit[] = [];
  for (const hit of ordered) {
    const content = hit.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(content)) continue;
    seen.add(content);
    const count = counts.get(hit.document_id) ?? 0;
    if (count >= 3) overflow.push(hit);
    else {
      selected.push(hit);
      counts.set(hit.document_id, count + 1);
    }
  }
  return [...selected, ...overflow].slice(0, limit);
}

/** Immutable passage identity is kept; surrounding context is available separately. */
export function passageEmbeddingText(
  p: Pick<SearchPassage, 'symbol' | 'title' | 'form' | 'text'>,
): string {
  return `${p.symbol} | ${p.form} | ${p.title.slice(0, 120)}\n${p.text}`;
}
