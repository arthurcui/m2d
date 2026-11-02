import type pg from 'pg';
import {
  ResearchError,
  factQuerySchema,
  type EvidenceSearch,
  type SearchPassage,
  type IndexCoverage,
} from '@m2d/research';

const fields = `d.id as document_id,ch.chunk_index,ch.page,ch.text,c.symbol,d.title,d.form,d.provider,d.revision,d.url,to_char(d.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at,to_char(d.available_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as available_at,d.hash`;
function scope(input: Omit<EvidenceSearch, 'query'>) {
  const values: unknown[] = [
    input.symbol,
    input.at ?? new Date().toISOString(),
  ];
  const clauses = ['c.symbol=$1', 'd.available_at<=$2'];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (input.revisions !== 'all')
    clauses.push(
      `not exists(select 1 from source_documents newer where newer.company_id=d.company_id and newer.provider=d.provider and newer.upstream_key=d.upstream_key and newer.revision>d.revision and newer.available_at<=$2)`,
    );
  if (input.forms?.length)
    clauses.push(`d.form=any(${bind(input.forms)}::text[])`);
  if (input.source) clauses.push(`d.provider=${bind(input.source)}`);
  if (input.publishedFrom)
    clauses.push(
      `d.published_at>=${bind(input.publishedFrom)}::date::timestamp at time zone 'UTC'`,
    );
  if (input.publishedTo)
    clauses.push(
      `d.published_at<(${bind(input.publishedTo)}::date+1)::timestamp at time zone 'UTC'`,
    );
  return { values, clauses: clauses.join(' and '), bind };
}
const joins =
  'document_chunks ch join source_documents d on d.id=ch.document_id join research_companies c on c.id=d.company_id';
const day = `(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')`;
export function createResearchSearchRepository(pool: pg.Pool) {
  return {
    async facts(raw: unknown) {
      const input = factQuerySchema.parse(raw),
        s = scope(input),
        conditions = [s.clauses];
      if (input.metric)
        conditions.push(
          `f.metric ilike ${s.bind('%' + input.metric.replace(/[%_\\]/g, '\\$&') + '%')}`,
        );
      if (input.unit) conditions.push(`f.unit=${s.bind(input.unit)}`);
      if (input.periodFrom)
        conditions.push(`f.period_end>=${s.bind(input.periodFrom)}::date`);
      if (input.periodTo)
        conditions.push(`f.period_end<=${s.bind(input.periodTo)}::date`);
      const limit = input.limit ?? 40,
        bound = s.bind(limit + 1);
      const rows = (
        await pool.query<{
          document_id: string;
          provider: string;
          metric: string;
          value: string;
          unit: string;
          period_start: string | null;
          period_end: string;
          filed: string;
          accession: string;
          available_at: string;
        }>(
          `select f.document_id,d.provider,f.metric,f.value::text,f.unit,f.period_start::text,f.period_end::text,f.filed::text,f.accession,d.available_at from company_facts f join source_documents d on d.id=f.document_id join research_companies c on c.id=d.company_id where ${conditions.join(' and ')} order by f.period_end desc,f.metric,f.filed desc,f.id limit ${bound}`,
          s.values,
        )
      ).rows;
      return {
        symbol: input.symbol,
        facts: rows.slice(0, limit).map((row) => ({
          ...row,
          citation: `/research?document=${row.document_id}`,
        })),
        truncated: rows.length > limit,
        notice:
          'Original reported values and units. Compare matching periods; separate accessions can be restatements. No derived ratios.',
      };
    },
    async recover() {
      await pool.query(
        "update research_search_jobs set status='interrupted',finished_at=now(),error='Indexing was interrupted. Continue indexing to reuse completed passages.' where status='running'",
      );
    },
    async startJob(id: string, symbol: string, profile: string) {
      try {
        const inserted = await pool.query(
          "insert into research_search_jobs(id,symbol,profile,status) values($1,$2,$3,'running') on conflict(id) do nothing returning id",
          [id, symbol, profile],
        );
        const row = (
          await pool.query<{
            id: string;
            symbol: string;
            profile: string;
            status: string;
          }>(
            'select id,symbol,profile,status from research_search_jobs where id=$1',
            [id],
          )
        ).rows[0]!;
        if (row.symbol !== symbol || row.profile !== profile)
          throw new ResearchError(
            'IDEMPOTENCY_CONFLICT',
            'This index request belongs to a different company or model.',
            409,
          );
        return { ...row, created: !!inserted.rowCount };
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505'
        )
          throw new ResearchError(
            'RESEARCH_INDEX_BUSY',
            'Another company index is processing. Wait for it to finish.',
            409,
          );
        throw error;
      }
    },
    async job(id: string) {
      const row = (
        await pool.query<{
          id: string;
          symbol: string;
          status: string;
          processed: number;
          error: string | null;
        }>(
          'select id,symbol,status,processed,error from research_search_jobs where id=$1',
          [id],
        )
      ).rows[0];
      if (!row)
        throw new ResearchError(
          'INDEX_JOB_NOT_FOUND',
          'Index request was not found.',
          404,
        );
      return row;
    },
    async latestJob(symbol: string) {
      return (
        (
          await pool.query<{
            id: string;
            status: string;
            processed: number;
            error: string | null;
          }>(
            'select id,status,processed,error from research_search_jobs where symbol=$1 order by started_at desc limit 1',
            [symbol],
          )
        ).rows[0] ?? null
      );
    },
    async progress(
      id: string,
      processed: number,
      status: string,
      error: string | null = null,
    ) {
      await pool.query(
        "update research_search_jobs set processed=$2,status=$3,error=$4,finished_at=case when $3='running' then null else now() end where id=$1",
        [id, processed, status, error],
      );
    },
    async companies(query: string, at?: string) {
      return (
        await pool.query<{ symbol: string; name: string; cik: string | null }>(
          `select symbol,name,cik from research_companies c where (symbol ilike $1 or name ilike $1 or cik=$2) and exists(select 1 from source_documents d where d.company_id=c.id and d.available_at<=$3) order by (symbol=upper($2)) desc,symbol limit 12`,
          [
            `%${query.replace(/[%_\\]/g, '\\$&')}%`,
            query,
            at ?? new Date().toISOString(),
          ],
        )
      ).rows;
    },
    async coverage(
      input: Omit<EvidenceSearch, 'query'>,
      profile: string,
    ): Promise<IndexCoverage> {
      const s = scope(input),
        p = s.bind(profile);
      const row = (
        await pool.query<{ total: number; indexed: number }>(
          `select count(*)::int total,count(e.embedding_id)::int indexed from ${joins} left join research_chunk_embeddings e on e.document_id=ch.document_id and e.chunk_index=ch.chunk_index and e.profile=${p} where ${s.clauses}`,
          s.values,
        )
      ).rows[0]!;
      return { ...row, pending: row.total - row.indexed };
    },
    async missing(symbol: string, profile: string) {
      // Index all immutable revisions: historical queries still need their original evidence.
      return (
        await pool.query<SearchPassage>(
          `select ${fields} from ${joins} where c.symbol=$1 and d.available_at<=now() and not exists(select 1 from research_chunk_embeddings e where e.document_id=ch.document_id and e.chunk_index=ch.chunk_index and e.profile=$2) order by d.available_at desc,d.id,ch.chunk_index limit 256`,
          [symbol, profile],
        )
      ).rows;
    },
    async lexical(input: EvidenceSearch) {
      const s = scope(input),
        exact = s.bind(input.query);
      // Preserve explicit web-search syntax; ordinary questions use broad term recall.
      const words = input.query.match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu) ?? [];
      const terms = words.filter(
        (word) =>
          ![
            'what',
            'which',
            'how',
            'does',
            'would',
            'could',
            'company',
            'please',
            'tell',
            'about',
          ].includes(word.toLowerCase()),
      );
      const query = /["()]|\bOR\b|(^|\s)-\w/.test(input.query)
        ? input.query
        : (terms.length ? terms : words).slice(0, 40).join(' OR ');
      const q = s.bind(query);
      return (
        await pool.query<SearchPassage>(
          `select ${fields} from ${joins} where ${s.clauses} and to_tsvector('english',ch.text) @@ websearch_to_tsquery('english',${q}) order by (position(lower(${exact}) in lower(ch.text))>0) desc,(to_tsvector('english',ch.text) @@ websearch_to_tsquery('english',${exact})) desc,ts_rank_cd(to_tsvector('english',ch.text),websearch_to_tsquery('english',${q}),32) desc,d.available_at desc,d.id,ch.chunk_index limit 96`,
          s.values,
        )
      ).rows;
    },
    async semantic(input: EvidenceSearch, profile: string, vector: number[]) {
      const s = scope(input),
        p = s.bind(profile),
        v = s.bind(JSON.stringify(vector));
      // Exact cosine over the company/time-filtered set avoids ANN post-filter recall loss.
      return (
        await pool.query<SearchPassage & { similarity: number }>(
          `with eligible as materialized(select ${fields},e.embedding from ${joins} join research_chunk_embeddings ce on ce.document_id=ch.document_id and ce.chunk_index=ch.chunk_index and ce.profile=${p} join research_embeddings e on e.id=ce.embedding_id and e.profile=${p} where ${s.clauses}) select document_id,chunk_index,page,text,symbol,title,form,provider,revision,url,published_at,available_at,hash,1-(embedding <=> ${v}::vector) as similarity from eligible where (embedding <=> ${v}::vector)<=0.75 order by embedding <=> ${v}::vector,available_at desc,document_id,chunk_index limit 96`,
          s.values,
        )
      ).rows;
    },
    async passage(id: string, index: number, at?: string) {
      const rows = (
        await pool.query<SearchPassage>(
          `select ${fields} from ${joins} where d.id=$1 and d.available_at<=$2 and ch.chunk_index between greatest(0,$3::int-1) and $3::int+1 order by ch.chunk_index`,
          [id, at ?? new Date().toISOString(), index],
        )
      ).rows;
      if (!rows.some((row) => row.chunk_index === index))
        throw new ResearchError(
          'PASSAGE_NOT_FOUND',
          'This passage is not available at the selected time.',
          404,
        );
      return { document_id: id, chunk_index: index, passages: rows };
    },
    async cached(id: string, profile: string): Promise<number[] | null> {
      const row = (
        await pool.query<{ embedding: string }>(
          'select embedding::text from research_embeddings where id=$1 and profile=$2',
          [id, profile],
        )
      ).rows[0];
      return row ? (JSON.parse(row.embedding) as number[]) : null;
    },
    async save(
      id: string,
      profile: string,
      purpose: 'query' | 'passage',
      vector: number[],
    ) {
      await pool.query(
        'insert into research_embeddings(id,profile,purpose,embedding) values($1,$2,$3,$4::vector) on conflict do nothing',
        [id, profile, purpose, JSON.stringify(vector)],
      );
    },
    async link(
      documentId: string,
      chunkIndex: number,
      profile: string,
      embeddingId: string,
    ) {
      await pool.query(
        'insert into research_chunk_embeddings(document_id,chunk_index,profile,embedding_id) values($1,$2,$3,$4) on conflict do nothing',
        [documentId, chunkIndex, profile, embeddingId],
      );
    },
    async reserve(input: {
      id: string;
      profile: string;
      purpose: string;
      bytes: number;
      dailyBytes: number;
      cost: string;
      priceVersion: string;
      dailyBudget: string | null;
      agentRunId?: string;
    }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Share the existing chat cost lock to prevent concurrent budget overspending.
        await client.query('select pg_advisory_xact_lock(241031,2)');
        const row = (
          await client.query<{ bytes: string; cost: string }>(
            `select coalesce(sum(input_bytes),0)::text bytes,coalesce(sum(cost) filter(where agent_run_id is null),0)::text cost from research_embedding_usage where created_at>=${day}`,
          )
        ).rows[0]!;
        if (Number(row.bytes) + input.bytes > input.dailyBytes)
          throw new ResearchError(
            'EMBEDDING_DAILY_LIMIT',
            'The daily search indexing allowance has been reached. Keyword search remains available.',
            429,
          );
        if (input.dailyBudget && !input.agentRunId) {
          const budget = (
            await client.query<{ ok: boolean }>(
              `select coalesce(sum(reserved_cost),0)+$1::numeric+$2::numeric<=$3::numeric ok from agent_runs where started_at>=${day}`,
              [row.cost, input.cost, input.dailyBudget],
            )
          ).rows[0]!;
          if (!budget.ok)
            throw new ResearchError(
              'DAILY_COST_LIMIT',
              'The configured daily inference budget would be exceeded.',
              429,
            );
        }
        await client.query(
          `insert into research_embedding_usage(id,profile,purpose,agent_run_id,input_bytes,cost,price_version,status) values($1,$2,$3,$4,$5,$6,$7,'reserved')`,
          [
            input.id,
            input.profile,
            input.purpose,
            input.agentRunId ?? null,
            input.bytes,
            input.cost,
            input.priceVersion,
          ],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async usage(id: string, tokens: number | null, cost: string | null) {
      await pool.query(
        `update research_embedding_usage set input_tokens=$2,cost=coalesce($3::numeric,cost),status=$4 where id=$1`,
        [id, tokens, cost, tokens === null ? 'uncertain' : 'completed'],
      );
    },
    async dailyUsage() {
      return (
        await pool.query<{
          inputBytes: number;
          inputTokens: number;
          estimatedCost: string;
          uncertain: number;
        }>(
          `select coalesce(sum(input_bytes),0)::int "inputBytes",coalesce(sum(input_tokens),0)::int "inputTokens",coalesce(sum(cost),0)::text "estimatedCost",count(*) filter(where status<>'completed')::int uncertain from research_embedding_usage where created_at>=${day}`,
        )
      ).rows[0]!;
    },
  };
}
export type ResearchSearchRepository = ReturnType<
  typeof createResearchSearchRepository
>;
