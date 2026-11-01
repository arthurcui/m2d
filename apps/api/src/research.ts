import type { ResearchSearchService, SearchBudget } from './research-search.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ResearchRepository, ResearchDocument } from '@m2d/db';
import {
  chunks,
  compareSchema,
  lookupSchema,
  searchSchema,
  evidenceSearchSchema,
  passageSchema,
  factQuerySchema,
  symbolSchema,
  sourceLinkSchema,
  sourcePresets,
  PublicResearchSources,
  type SourceLink,
  ResearchError,
  type ResearchProvider,
  type Source,
  type Chunk,
} from '@m2d/research';
export type ResearchComparison = {
  before: ResearchDocument & { chunks?: undefined; findings?: unknown };
  after: ResearchDocument & { chunks?: undefined; findings?: unknown };
  removed: Chunk[];
  added: Chunk[];
  truncated: boolean;
  method: string;
};
export interface ResearchService {
  repository: ResearchRepository;
  sources: PublicResearchSources;
  discovery?: ResearchSearchService;
  status(): { provider: 'fixture' | 'sec'; configured: boolean };
  close(): Promise<void>;
  start(input: {
    idempotencyKey: string;
    symbol: string;
    upload?: Source;
    link?: SourceLink;
    news?: boolean;
  }): Promise<{ id: string; status: string }>;
  compare(
    before: string,
    after: string,
    at?: string,
  ): Promise<ResearchComparison>;
  tool(
    name: string,
    args: unknown,
    at?: string,
    budget?: SearchBudget,
  ): Promise<unknown>;
}
export function createResearchService(
  repository: ResearchRepository,
  provider: ResearchProvider,
  discovery?: ResearchSearchService,
  sources = new PublicResearchSources('fixture'),
): ResearchService {
  const running = new Map<string, Promise<void>>();
  return {
    repository,
    sources,
    ...(discovery ? { discovery } : {}),
    status: () => ({ provider: provider.id, configured: provider.configured }),
    async close() {
      await Promise.allSettled(running.values());
      await discovery?.close();
    },
    async start(input: {
      idempotencyKey: string;
      symbol: string;
      upload?: Source;
      link?: SourceLink;
      news?: boolean;
    }) {
      const p = input.link
        ? sources.mode === 'fixture'
          ? 'fixture'
          : input.link.kind
        : input.upload
          ? input.upload.form === 'ANALYST'
            ? 'analyst'
            : 'upload'
          : provider.id;
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            symbol: input.symbol,
            provider: p,
            ...(input.link
              ? { link: input.link, news: input.news ?? false }
              : {}),
            upload: input.upload
              ? {
                  ...input.upload,
                  raw: Buffer.from(input.upload.raw).toString('base64'),
                }
              : null,
          }),
        )
        .digest('hex');
      if (running.size && !running.has(input.idempotencyKey))
        throw new ResearchError(
          'RESEARCH_BUSY',
          'Another document import is processing. Please wait for it to finish.',
          409,
        );
      const previous = await repository.begin(
        input.idempotencyKey,
        input.symbol,
        p,
        fingerprint,
      );
      if (!previous.created)
        return { id: input.idempotencyKey, status: previous.status };
      const task = (async () => {
        try {
          const result = input.link
            ? {
                name: input.symbol,
                cik: null,
                sources: await sources.fetch(input.link, input.news),
              }
            : input.upload
              ? { name: input.symbol, cik: null, sources: [input.upload] }
              : await provider.fetch(input.symbol);
          const prepared = [];
          for (const source of result.sources)
            prepared.push({
              ...source,
              chunks: source.form === 'INDEX' ? [] : await chunks(source),
            });
          await repository.commit(
            input.idempotencyKey,
            input.symbol,
            result.name,
            result.cik,
            p,
            prepared,
          );
        } catch (e) {
          await repository.failed(
            input.idempotencyKey,
            e instanceof ResearchError
              ? `${e.code}: ${e.message}`
              : 'Research import failed. Verify the source format and retry; saved documents are unchanged.',
          );
        }
      })();
      running.set(input.idempotencyKey, task);
      void task
        .finally(() => running.delete(input.idempotencyKey))
        .catch(() => undefined);
      return { id: input.idempotencyKey, status: 'running' };
    },
    async compare(
      before: string,
      after: string,
      at?: string,
    ): Promise<{
      before: ResearchDocument & { chunks?: undefined; findings?: unknown };
      after: ResearchDocument & { chunks?: undefined; findings?: unknown };
      removed: Chunk[];
      added: Chunk[];
      truncated: boolean;
      method: string;
    }> {
      const [a, b] = await Promise.all([
        repository.document(before, at),
        repository.document(after, at),
      ]);
      if (a.company_id !== b.company_id)
        throw new ResearchError(
          'DIFFERENT_COMPANIES',
          'Choose documents for the same company.',
        );
      if (a.id === b.id)
        throw new ResearchError(
          'SAME_DOCUMENT',
          'Choose two different reports or revisions.',
        );
      const old = new Set(a.chunks.map((c) => c.text)),
        next = new Set(b.chunks.map((c) => c.text));
      const removed = a.chunks.filter((c) => !next.has(c.text)),
        added = b.chunks.filter((c) => !old.has(c.text));
      return {
        before: { ...a, chunks: undefined },
        after: { ...b, chunks: undefined },
        removed: removed.slice(0, 20),
        added: added.slice(0, 20),
        truncated: removed.length > 20 || added.length > 20,
        method:
          'Exact passage changes; changed passages are not necessarily semantically equivalent. Financial periods and units must be compared explicitly.',
      };
    },
    async tool(
      name: string,
      args: unknown,
      at?: string,
      budget?: SearchBudget,
    ): Promise<unknown> {
      if (at) {
        const record = z.record(z.string(), z.unknown()).parse(args);
        args = {
          ...record,
          at: typeof record.at === 'string' && record.at < at ? record.at : at,
        };
      }
      if (
        name === 'research_search_evidence_v2' ||
        name === 'research_read_passage_v1' ||
        name === 'research_find_company_v1' ||
        name === 'research_query_facts_v2'
      ) {
        if (!discovery)
          throw new ResearchError(
            'SEARCH_UNAVAILABLE',
            'Company search is not configured.',
            503,
          );
        if (name === 'research_search_evidence_v2')
          return discovery.search(evidenceSearchSchema.parse(args), budget);
        if (name === 'research_query_facts_v2')
          return discovery.repository.facts(factQuerySchema.parse(args));
        if (name === 'research_read_passage_v1') {
          const a = passageSchema.parse(args);
          return discovery.repository.passage(a.documentId, a.chunkIndex, a.at);
        }
        const a = z
          .object({
            query: z.string().trim().min(1).max(150),
            at: z.iso.datetime().optional(),
          })
          .parse(args);
        return discovery.repository.companies(a.query, a.at);
      }
      if (name === 'research_search_filings_v1') {
        const a = lookupSchema.parse(args);
        return (await repository.timeline(a.symbol, a.at)).slice(0, 20);
      }
      if (name === 'research_search_documents_v1') {
        const a = searchSchema.parse(args);
        return repository.search(a.symbol, a.query, a.at);
      }
      if (name === 'research_get_company_facts_v1') {
        const a = lookupSchema.parse(args);
        return (await repository.facts(a.symbol, a.at)).slice(0, 40);
      }
      if (name === 'research_compare_revisions_v1') {
        const a = compareSchema.parse(args);
        const c = await this.compare(a.before, a.after, a.at);
        return {
          ...c,
          before: { ...c.before, findings: undefined },
          after: { ...c.after, findings: undefined },
          removed: c.removed.slice(0, 3),
          added: c.added.slice(0, 3),
          truncated: c.truncated || c.removed.length > 3 || c.added.length > 3,
        };
      }
      throw new ResearchError(
        'UNKNOWN_RESEARCH_TOOL',
        'This research tool is unavailable.',
      );
    },
  };
}

export async function researchRoutes(
  app: FastifyInstance,
  { service: s }: { service: ResearchService },
) {
  const envelope = (data: unknown) => ({
    data,
    meta: {
      version: 1,
      asOf: new Date().toISOString(),
      source: s.status().provider,
    },
  });
  const docId = (params: unknown) =>
    z.object({ id: z.uuid() }).parse(params).id;
  const query = z.object({ at: z.iso.datetime().optional() });
  app.addHook('onClose', () => s.close());
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'POST' && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          return reply.code(403).send({
            error: {
              code: 'ORIGIN_REJECTED',
              message: 'Use the same-origin application proxy.',
            },
          });
      } catch {
        return reply.code(403).send({
          error: {
            code: 'ORIGIN_REJECTED',
            message: 'Use the same-origin application proxy.',
          },
        });
      }
    }
  });
  const sourceEnvelope = (data: unknown) => ({
    data,
    meta: {
      version: 1,
      asOf: new Date().toISOString(),
      source: s.sources.mode === 'fixture' ? 'fixture' : 'public-sources',
    },
  });
  const sourceRequest = z
    .object({
      version: z.literal(1),
      symbol: symbolSchema,
      preset: z.string().max(80).optional(),
      link: sourceLinkSchema.optional(),
    })
    .strict();
  function resolveSource(input: z.infer<typeof sourceRequest>) {
    if (Boolean(input.preset) === Boolean(input.link))
      throw new ResearchError(
        'INVALID_SOURCE',
        'Choose one source or public document link.',
      );
    if (input.link) {
      if (input.link.symbol !== input.symbol)
        throw new ResearchError(
          'SOURCE_COMPANY_MISMATCH',
          'The source belongs to a different selected company.',
        );
      return { link: input.link, news: false };
    }
    const preset = sourcePresets(input.symbol, s.sources.newsConfigured).find(
      (p) => p.id === input.preset,
    );
    if (!preset)
      throw new ResearchError(
        'SOURCE_NOT_FOUND',
        'This source is not available for the selected company.',
        404,
      );
    if (!preset.configured)
      throw new ResearchError(
        'SOURCE_NOT_CONFIGURED',
        'Configure the backend Massive key to retrieve news.',
        503,
      );
    const { symbol, kind, name, url } = preset;
    return {
      link: { symbol, kind, name, url },
      news: preset.id === 'massive-news',
    };
  }
  app.get('/api/v1/research/sources', async (req) => {
    const { symbol } = lookupSchema.parse(req.query);
    return sourceEnvelope({
      mode: s.sources.mode,
      saved: await s.repository.sourceLinks(symbol),
      presets: sourcePresets(symbol, s.sources.newsConfigured),
    });
  });
  app.post('/api/v1/research/sources', async (req) => {
    const { version: _version, ...input } = sourceLinkSchema
      .extend({ version: z.literal(1) })
      .parse(req.body);
    void _version;
    return sourceEnvelope(await s.repository.saveSourceLink(input));
  });
  app.post('/api/v1/research/sources/remove', async (req) => {
    const input = z
      .object({ version: z.literal(1), id: z.uuid() })
      .strict()
      .parse(req.body);
    await s.repository.removeSourceLink(input.id);
    return sourceEnvelope({ removed: true });
  });
  app.post('/api/v1/research/sources/discover', async (req) => {
    const input = sourceRequest.parse(req.body),
      source = resolveSource(input);
    if (source.news)
      throw new ResearchError(
        'SOURCE_NOT_BROWSABLE',
        'Retrieve news summaries directly.',
      );
    return sourceEnvelope({ links: await s.sources.discover(source.link) });
  });
  app.post('/api/v1/research/sources/import', async (req, reply) => {
    const input = sourceRequest
      .extend({ idempotencyKey: z.uuid() })
      .parse(req.body);
    const source = resolveSource(input);
    return reply.code(202).send(
      sourceEnvelope(
        await s.start({
          idempotencyKey: input.idempotencyKey,
          symbol: input.symbol,
          ...source,
        }),
      ),
    );
  });
  app.get('/api/v1/research', async () =>
    envelope({
      ...s.status(),
      companies: await s.repository.companies(),
      imports: await s.repository.imports(),
    }),
  );
  app.get('/api/v1/research/imports/:id', async (req) =>
    envelope(await s.repository.import(docId(req.params))),
  );
  app.get('/api/v1/research/companies/:symbol', async (req) => {
    const { symbol } = z.object({ symbol: symbolSchema }).parse(req.params),
      { at } = query.parse(req.query);
    return envelope({
      documents: await s.repository.timeline(symbol, at),
      facts: await s.repository.facts(symbol, at),
    });
  });
  app.get('/api/v1/research/documents/:id', async (req) =>
    envelope(
      await s.repository.document(docId(req.params), query.parse(req.query).at),
    ),
  );
  app.get('/api/v1/research/documents/:id/raw', async (req, reply) => {
    const id = docId(req.params),
      raw = await s.repository.raw(id);
    // Original HTML/PDF is download-only: never execute a source in the app origin.
    return reply
      .header(
        'Content-Disposition',
        `attachment; filename="${id}.${raw.mime === 'application/pdf' ? 'pdf' : raw.mime === 'text/html' ? 'html' : raw.mime === 'application/json' ? 'json' : 'txt'}"`,
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .type('application/octet-stream')
      .send(raw.data);
  });
  app.get('/api/v1/research/search', async (req) => {
    const a = searchSchema.parse(req.query);
    return envelope(await s.repository.search(a.symbol, a.query, a.at));
  });
  if (s.discovery) {
    const search = s.discovery;
    app.post('/api/v1/research/search', async (req) => {
      const { version, ...input } = evidenceSearchSchema
        .safeExtend({ version: z.literal(2) })
        .parse(req.body);
      return {
        ...envelope(await search.search(input)),
        meta: {
          version,
          asOf: new Date().toISOString(),
          source: s.status().provider,
        },
      };
    });
    app.get('/api/v1/research/search/status', async (req) => {
      const a = lookupSchema.parse(req.query);
      return envelope(await search.status(a.symbol, a.at));
    });
    app.get('/api/v1/research/search/jobs/:id', async (req) =>
      envelope(await search.repository.job(docId(req.params))),
    );
    app.get('/api/v1/research/companies', async (req) => {
      const a = z
        .object({
          query: z.string().trim().min(1).max(150),
          at: z.iso.datetime().optional(),
        })
        .parse(req.query);
      return envelope(await search.repository.companies(a.query, a.at));
    });
    app.post('/api/v1/research/search/index', async (req, reply) => {
      const a = z
        .object({
          version: z.literal(1),
          symbol: symbolSchema,
          idempotencyKey: z.uuid(),
        })
        .strict()
        .parse(req.body);
      return reply
        .code(202)
        .send(envelope(await search.startIndex(a.symbol, a.idempotencyKey)));
    });
  }
  app.post('/api/v1/research/compare', async (req) => {
    const a = compareSchema.extend({ version: z.literal(1) }).parse(req.body);
    return envelope(await s.compare(a.before, a.after, a.at));
  });
  app.post('/api/v1/research/import', async (req, reply) => {
    const a = z
      .object({
        version: z.literal(1),
        idempotencyKey: z.uuid(),
        symbol: symbolSchema,
      })
      .strict()
      .parse(req.body);
    return reply.code(202).send(envelope(await s.start(a)));
  });
  app.post(
    '/api/v1/research/upload',
    { bodyLimit: 17 * 1024 * 1024 },
    async (req, reply) => {
      const a = z
        .object({
          version: z.literal(1),
          idempotencyKey: z.uuid(),
          symbol: symbolSchema,
          name: z.string().trim().min(1).max(180),
          contentBase64: z
            .string()
            .min(4)
            .max(16 * 1024 * 1024),
          publishedAt: z.iso.datetime().nullable().default(null),
          category: z.enum(['upload', 'analyst']).default('upload'),
        })
        .strict()
        .parse(req.body);
      if (!/\.(pdf|txt)$/i.test(a.name))
        throw new ResearchError(
          'UNSUPPORTED_DOCUMENT',
          'Choose a PDF or UTF-8 .txt document.',
        );
      const raw = Buffer.from(a.contentBase64, 'base64');
      if (
        raw.toString('base64') !== a.contentBase64 ||
        raw.length > 12 * 1024 * 1024
      )
        throw new ResearchError(
          'INVALID_DOCUMENT',
          'The file is invalid or larger than 12 MiB.',
        );
      return reply.code(202).send(
        envelope(
          await s.start({
            idempotencyKey: a.idempotencyKey,
            symbol: a.symbol,
            upload: {
              key: a.name,
              title: a.name,
              form: a.category === 'analyst' ? 'ANALYST' : 'UPLOAD',
              url: null,
              publishedAt: a.publishedAt,
              mime: /\.pdf$/i.test(a.name) ? 'application/pdf' : 'text/plain',
              raw,
            },
          }),
        ),
      );
    },
  );
}
