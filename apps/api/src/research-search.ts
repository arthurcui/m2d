import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { ResearchSearchRepository } from '@m2d/db';
import { LlmError, type LlmProvider } from '@m2d/llm';
import {
  evidenceSearchSchema,
  passageEmbeddingText,
  rankEvidence,
  ResearchError,
  type EvidenceSearch,
  type SearchResponse,
} from '@m2d/research';

export type SearchBudget = {
  signal?: AbortSignal;
  agentRunId?: string;
  before?(reservation: string): Promise<void>;
  after?(
    tokens: number | null,
    reservation: string,
    actual: string | null,
  ): Promise<void>;
};
export function createResearchSearchService(
  repository: ResearchSearchRepository,
  provider: LlmProvider | null,
  options: { dailyBytes: number; dailyBudget: string | null },
) {
  const model =
    provider?.id === 'fixture'
      ? 'fixture-embedding-v1'
      : 'text-embedding-3-small';
  const profile = `${provider?.id ?? 'unconfigured'}:${model}:1536:passage-v1:${provider?.adapterVersion ?? 'none'}`;
  const priceVersion =
    provider?.id === 'fixture'
      ? 'fixture-zero'
      : 'openai-embedding-small-2026-10-31';
  const cost = (tokens: number) =>
    new Decimal(tokens)
      .mul(provider?.id === 'fixture' ? '0' : '0.02')
      .div(1000000)
      .toFixed(12);
  const jobs = new Set<Promise<void>>(),
    queries = new Map<string, Promise<number[]>>();
  const hash = (purpose: string, text: string) =>
    createHash('sha256')
      .update(JSON.stringify([profile, purpose, text]))
      .digest('hex');
  async function embed(
    input: string[],
    purpose: 'query' | 'passage',
    budget: SearchBudget = {},
  ) {
    if (!provider?.embed)
      throw new ResearchError(
        'EMBEDDINGS_UNCONFIGURED',
        'Configure the backend inference provider before building a semantic index.',
        503,
      );
    const bytes = input.reduce(
        (sum, text) => sum + Buffer.byteLength(text, 'utf8'),
        0,
      ),
      reservation = cost(bytes),
      id = randomUUID();
    // One UTF-8 byte is a conservative token upper bound for this text embedding model.
    await budget.before?.(reservation);
    try {
      await repository.reserve({
        id,
        profile,
        purpose,
        bytes,
        dailyBytes: options.dailyBytes,
        cost: reservation,
        priceVersion,
        dailyBudget: options.dailyBudget,
        ...(budget.agentRunId ? { agentRunId: budget.agentRunId } : {}),
      });
    } catch (error) {
      await budget.after?.(0, reservation, '0');
      throw error;
    }
    let tokens: number | null = null,
      actual: string | null = null;
    try {
      const response = await provider.embed(
        { model, input, dimensions: 1536, timeoutMs: 20000 },
        budget.signal,
      );
      tokens = response.inputTokens;
      actual = cost(tokens);
      if (
        response.vectors.length !== input.length ||
        response.vectors.some(
          (v) =>
            v.length !== 1536 ||
            v.some((n) => !Number.isFinite(n)) ||
            !v.some((n) => n !== 0),
        )
      )
        throw new ResearchError(
          'INVALID_EMBEDDINGS',
          'The embedding provider returned incompatible vectors.',
          502,
        );
      return response.vectors;
    } finally {
      await repository.usage(id, tokens, actual);
      await budget.after?.(tokens, reservation, actual);
    }
  }
  return {
    profile,
    repository,
    async close() {
      await Promise.allSettled([...jobs, ...queries.values()]);
    },
    async status(symbol: string, at?: string) {
      const [coverage, usage, job] = await Promise.all([
        repository.coverage({ symbol, ...(at ? { at } : {}) }, profile),
        repository.dailyUsage(),
        repository.latestJob(symbol),
      ]);
      return {
        provider: provider?.id ?? null,
        model,
        configured: !!provider?.embed,
        profile,
        coverage,
        usage,
        dailyBytes: options.dailyBytes,
        job,
      };
    },
    async search(
      raw: EvidenceSearch,
      budget: SearchBudget = {},
    ): Promise<SearchResponse> {
      const parsed = evidenceSearchSchema.parse(raw),
        input = { ...parsed, at: parsed.at ?? new Date().toISOString() };
      const coverage = await repository.coverage(input, profile),
        warnings: string[] = [];
      const mode = input.mode ?? (coverage.indexed ? 'hybrid' : 'keyword');
      if (!input.mode && !coverage.indexed && coverage.total)
        warnings.push(
          'Keyword search only: build the company semantic index to find meaning-based matches.',
        );
      if (mode !== 'keyword' && coverage.total && !coverage.indexed)
        throw new ResearchError(
          'SEMANTIC_INDEX_REQUIRED',
          'Build the company search index first, or explicitly select Keyword search.',
          409,
        );
      if (mode !== 'keyword' && coverage.pending)
        warnings.push(
          `Semantic coverage is partial: ${coverage.indexed} of ${coverage.total} eligible passages indexed. Continue indexing for complete coverage.`,
        );
      if (provider?.id === 'fixture' && mode !== 'keyword')
        warnings.push(
          'Synthetic fixture embeddings: this demonstrates retrieval mechanics, not real semantic accuracy.',
        );
      let vector: number[] | null = null,
        cached = false;
      if (mode !== 'keyword' && coverage.indexed) {
        const text = input.query.replace(/\s+/g, ' ').trim(),
          id = hash('query', text);
        vector = await repository.cached(id, profile);
        cached = !!vector;
        if (!vector) {
          let pending = queries.get(id);
          if (pending) cached = true;
          else {
            pending = (async () => {
              const vectors = await embed([text], 'query', budget),
                result = vectors[0]!;
              await repository.save(id, profile, 'query', result);
              return result;
            })();
            queries.set(id, pending);
          }
          try {
            vector = await pending;
          } finally {
            if (queries.get(id) === pending) queries.delete(id);
          }
        }
      }
      const [lexical, semantic] = await Promise.all([
        mode === 'semantic' ? [] : repository.lexical(input),
        vector ? repository.semantic(input, profile, vector) : [],
      ]);
      const hits = rankEvidence(lexical, semantic, input.limit ?? 12);
      if (!hits.length)
        warnings.push(
          'No matching stored evidence was found within these filters. Broaden the query or import relevant reports; absence of results is not evidence that a risk is absent.',
        );
      return {
        version: 2,
        symbol: input.symbol,
        query: input.query,
        at: input.at,
        mode,
        ranking: 'rrf-v1',
        hits,
        coverage,
        warnings,
        embedding: vector ? { provider: provider!.id, model, cached } : null,
      };
    },
    async startIndex(symbol: string, idempotencyKey: string) {
      if (!provider?.embed)
        throw new ResearchError(
          'EMBEDDINGS_UNCONFIGURED',
          'Configure the backend inference provider before building the index.',
          503,
        );
      const prior = await repository.startJob(idempotencyKey, symbol, profile);
      if (!prior.created) return { id: prior.id, status: prior.status };
      const task = (async () => {
        let processed = 0;
        try {
          const rows = await repository.missing(symbol, profile);
          for (let start = 0; start < rows.length; start += 32) {
            const batch = rows.slice(start, start + 32),
              pending = [];
            for (const row of batch) {
              const text = passageEmbeddingText(row),
                id = hash('passage', text),
                cached = await repository.cached(id, profile);
              if (cached) {
                await repository.link(
                  row.document_id,
                  row.chunk_index,
                  profile,
                  id,
                );
                processed++;
              } else pending.push({ row, text, id });
            }
            if (pending.length) {
              const unique = [
                ...new Map(pending.map((item) => [item.id, item])).values(),
              ];
              const vectors = await embed(
                unique.map((p) => p.text),
                'passage',
              );
              for (const [i, item] of unique.entries()) {
                await repository.save(item.id, profile, 'passage', vectors[i]!);
              }
              for (const item of pending) {
                await repository.link(
                  item.row.document_id,
                  item.row.chunk_index,
                  profile,
                  item.id,
                );
                processed++;
              }
            }
            await repository.progress(prior.id, processed, 'running');
          }
          await repository.progress(prior.id, processed, 'completed');
        } catch (error) {
          await repository.progress(
            prior.id,
            processed,
            'failed',
            error instanceof ResearchError || error instanceof LlmError
              ? `${error.code}: ${error.message}`
              : 'Indexing failed. Completed passages are saved; retry to continue.',
          );
        }
      })();
      jobs.add(task);
      void task.finally(() => jobs.delete(task)).catch(() => undefined);
      return { id: prior.id, status: 'running' };
    },
  };
}
export type ResearchSearchService = ReturnType<
  typeof createResearchSearchService
>;
