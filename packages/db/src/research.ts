import type pg from 'pg';
import { createHash } from 'node:crypto';
import {
  ResearchError,
  type Source,
  type Chunk,
  type SourceLink,
  type SavedSourceLink,
} from '@m2d/research';
export type PreparedSource = Source & { chunks: Chunk[] };
export type ResearchDocument = {
  id: string;
  company_id: string;
  symbol: string;
  title: string;
  form: string;
  provider: string;
  url: string | null;
  published_at: string | null;
  observed_at: string;
  available_at: string;
  hash: string;
  revision: number;
  mime: string;
  upstream_key: string;
};
const columns = `d.id,d.company_id,c.symbol,d.title,d.form,d.provider,d.url,d.published_at,d.observed_at,d.available_at,d.hash,d.revision,d.mime,d.upstream_key`;
const date = (at?: string) => at ?? new Date().toISOString();
export function createResearchRepository(pool: pg.Pool) {
  return {
    async sourceLinks(symbol: string) {
      return (
        await pool.query<SavedSourceLink>(
          'select * from research_source_links where symbol=$1 order by created_at,id',
          [symbol],
        )
      ).rows;
    },
    async saveSourceLink(input: SourceLink) {
      const result = await pool.query<SavedSourceLink>(
        'insert into research_source_links(symbol,kind,name,url) values($1,$2,$3,$4) on conflict(symbol,kind,url) do update set name=excluded.name returning *',
        [input.symbol, input.kind, input.name, input.url],
      );
      return result.rows[0]!;
    },
    async removeSourceLink(id: string) {
      await pool.query('delete from research_source_links where id=$1', [id]);
    },
    async begin(
      id: string,
      symbol: string,
      provider: string,
      fingerprint: string,
    ) {
      const inserted = await pool.query(
        `insert into research_imports(id,symbol,provider,fingerprint,status) values($1,$2,$3,$4,'running') on conflict do nothing`,
        [id, symbol, provider, fingerprint],
      );
      const r = await pool.query<{
        fingerprint: string;
        status: string;
        document_ids: string[];
        error: string | null;
      }>(
        `select fingerprint,status,document_ids,error from research_imports where id=$1`,
        [id],
      );
      if (r.rows[0]?.fingerprint !== fingerprint)
        throw new ResearchError(
          'IDEMPOTENCY_CONFLICT',
          'This request ID was already used for different research.',
          409,
        );
      return { ...r.rows[0]!, created: inserted.rowCount === 1 };
    },
    async failed(id: string, message: string) {
      await pool.query(
        `update research_imports set status='failed',error=$2,finished_at=now() where id=$1 and status='running'`,
        [id, message],
      );
    },
    async recover() {
      await pool.query(
        `update research_imports set status='interrupted',error='API restarted. Retry the import.',finished_at=now() where status='running'`,
      );
    },
    async import(id: string) {
      const row = (
        await pool.query(
          `select id,symbol,provider,status,started_at,finished_at,document_ids,error from research_imports where id=$1`,
          [id],
        )
      ).rows[0];
      if (!row)
        throw new ResearchError(
          'IMPORT_NOT_FOUND',
          'Research import not found.',
          404,
        );
      return row;
    },
    async imports() {
      return (
        await pool.query(
          `select id,symbol,provider,status,started_at,finished_at,document_ids,error from research_imports order by started_at desc limit 20`,
        )
      ).rows;
    },
    async commit(
      id: string,
      symbol: string,
      name: string,
      cik: string | null,
      provider: string,
      sources: PreparedSource[],
    ) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
          `research:${symbol}`,
        ]);
        const existing = (
          await client.query<{ cik: string | null }>(
            `select cik from research_companies where symbol=$1`,
            [symbol],
          )
        ).rows[0];
        if (cik && existing?.cik && existing.cik !== cik)
          throw new ResearchError(
            'ISSUER_IDENTITY_CHANGED',
            'This ticker now resolves to a different SEC issuer. Existing research was preserved; resolve the issuer identity before importing.',
            409,
          );
        const c = await client.query<{ id: string }>(
          `insert into research_companies(symbol,name,cik) values($1,$2,$3) on conflict(symbol) do update set name=case when $3::text is not null then excluded.name else research_companies.name end,cik=coalesce(research_companies.cik,excluded.cik) returning id`,
          [symbol, name, cik],
        );
        const companyId = c.rows[0]!.id;
        const ids: string[] = [];
        for (const s of sources) {
          const hash = createHash('sha256').update(s.raw).digest('hex');
          const duplicate = await client.query<{ id: string }>(
            `select id from source_documents where company_id=$1 and provider=$2 and upstream_key=$3 and hash=$4`,
            [companyId, provider, s.key, hash],
          );
          if (duplicate.rows[0]) {
            ids.push(duplicate.rows[0].id);
            continue;
          }
          const r = await client.query<{ id: string }>(
            `insert into source_documents(company_id,provider,upstream_key,title,form,url,published_at,observed_at,available_at,hash,revision,mime,raw_base64) select $1,$2,$3,$4,$5,$6,$7,date_trunc('milliseconds',now()),greatest(date_trunc('milliseconds',now()),$7::timestamptz),$8,coalesce(max(revision),0)+1,$9,$10 from source_documents where company_id=$1 and provider=$2 and upstream_key=$3 returning id`,
            [
              companyId,
              provider,
              s.key,
              s.title,
              s.form,
              s.url,
              s.publishedAt,
              hash,
              s.mime,
              Buffer.from(s.raw).toString('base64'),
            ],
          );
          const documentId = r.rows[0]!.id;
          ids.push(documentId);
          // Bounded JSON recordsets keep large annual reports out of per-row round trips.
          await client.query(
            `insert into document_chunks(document_id,chunk_index,page,text) select $1,x.index,x.page,x.text from jsonb_to_recordset($2::jsonb) as x(index int,page int,text text)`,
            [documentId, JSON.stringify(s.chunks)],
          );
          await client.query(
            `insert into company_facts(document_id,metric,unit,period_start,period_end,value,accession,filed) select $1,x.metric,x.unit,x.start::date,x.end::date,x.value::numeric,x.accession,x.filed::date from jsonb_to_recordset($2::jsonb) as x(metric text,unit text,start text,"end" text,value text,accession text,filed text)`,
            [documentId, JSON.stringify(s.facts ?? [])],
          );
          const findings = s.chunks
            .flatMap((chunk) =>
              chunk.text
                .split(/(?<=[.!?])\s+|\n\n/)
                .filter((v) => v.length >= 30 && v.length <= 900)
                .map((claim) => ({
                  index: chunk.index,
                  claim,
                  category: /outlook|guidance|expect|forecast/i.test(claim)
                    ? 'guidance'
                    : /risk|uncertain|concentrat|adverse/i.test(claim)
                      ? 'risk'
                      : /revenue|income|cash flow/i.test(claim)
                        ? 'financial'
                        : 'business',
                })),
            )
            .filter((f) => f.category !== 'business')
            .slice(0, 100);
          await client.query(
            `insert into research_findings(document_id,chunk_index,claim,category,extractor_version) select $1,x.index,x.claim,x.category,'quoted-passages-v1' from jsonb_to_recordset($2::jsonb) as x(index int,claim text,category text)`,
            [documentId, JSON.stringify(findings)],
          );
        }
        await client.query(
          `update research_imports set status='completed',document_ids=$2,finished_at=now() where id=$1`,
          [id, JSON.stringify(ids)],
        );
        await client.query('commit');
        return ids;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
    async companies() {
      return (
        await pool.query(
          `select c.id,c.symbol,c.name,c.cik,count(d.id)::int as documents,max(d.observed_at) as updated_at from research_companies c left join source_documents d on d.company_id=c.id group by c.id order by c.symbol`,
        )
      ).rows;
    },
    async timeline(symbol: string, at?: string) {
      return (
        await pool.query<ResearchDocument>(
          `select ${columns} from source_documents d join research_companies c on c.id=d.company_id where c.symbol=$1 and d.available_at<=$2 order by d.available_at desc,d.published_at desc nulls last,d.revision desc,d.title limit 200`,
          [symbol, date(at)],
        )
      ).rows;
    },
    async document(id: string, at?: string) {
      const d = (
        await pool.query<ResearchDocument>(
          `select ${columns} from source_documents d join research_companies c on c.id=d.company_id where d.id=$1 and d.available_at<=$2`,
          [id, date(at)],
        )
      ).rows[0];
      if (!d)
        throw new ResearchError(
          'DOCUMENT_NOT_AVAILABLE',
          'Document is not available at this time.',
          404,
        );
      const chunks = (
        await pool.query<{ index: number; page: number | null; text: string }>(
          `select chunk_index as index,page,text from document_chunks where document_id=$1 order by chunk_index`,
          [id],
        )
      ).rows;
      const findings = (
        await pool.query<{
          id: string;
          chunk_index: number;
          claim: string;
          category: string;
          extractor_version: string;
        }>(
          `select * from research_findings where document_id=$1 order by chunk_index`,
          [id],
        )
      ).rows;
      return { ...d, chunks, findings };
    },
    async raw(id: string) {
      const row = (
        await pool.query<{ raw_base64: string; mime: string }>(
          `select raw_base64,mime from source_documents where id=$1 and available_at<=now()`,
          [id],
        )
      ).rows[0];
      if (!row)
        throw new ResearchError(
          'DOCUMENT_NOT_AVAILABLE',
          'Document is not available.',
          404,
        );
      return { data: Buffer.from(row.raw_base64, 'base64'), mime: row.mime };
    },
    async search(symbol: string, query: string, at?: string) {
      return (
        await pool.query(
          `select ${columns},ch.chunk_index,ch.page,ch.text,ts_rank_cd(to_tsvector('english',ch.text),websearch_to_tsquery('english',$2)) as rank from document_chunks ch join source_documents d on d.id=ch.document_id join research_companies c on c.id=d.company_id where c.symbol=$1 and d.available_at<=$3 and to_tsvector('english',ch.text) @@ websearch_to_tsquery('english',$2) order by rank desc,d.available_at desc limit 12`,
          [symbol, query, date(at)],
        )
      ).rows;
    },
    async facts(symbol: string, at?: string) {
      return (
        await pool.query(
          `select f.id,f.document_id,f.metric,f.unit,f.period_start::text as period_start,f.period_end::text as period_end,f.value::text as value,f.accession,f.filed::text as filed,d.provider,d.url,d.available_at,d.revision from company_facts f join source_documents d on d.id=f.document_id join research_companies c on c.id=d.company_id where c.symbol=$1 and d.available_at<=$2 and d.id in (select distinct on (provider,upstream_key) id from source_documents where company_id=c.id and available_at<=$2 order by provider,upstream_key,revision desc) order by period_end desc,metric,filed desc limit 500`,
          [symbol, date(at)],
        )
      ).rows;
    },
  };
}
export type ResearchRepository = ReturnType<typeof createResearchRepository>;
