'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { SearchResponse, IndexCoverage } from '@m2d/research';
type Status = {
  provider: string | null;
  model: string;
  configured: boolean;
  coverage: IndexCoverage;
  dailyBytes: number;
  usage: { inputBytes: number; estimatedCost: string; uncertain: number };
  job: {
    id: string;
    status: string;
    processed: number;
    error: string | null;
  } | null;
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/research${path}`, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = (await r.json()) as {
    data: T;
    error?: { message: string; details?: { message: string }[] };
  };
  if (!r.ok)
    throw new Error(
      result.error?.details?.map((issue) => issue.message).join(' ') ||
        result.error?.message ||
        'Search request failed.',
    );
  return result.data;
}
function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Vancouver',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Not supplied';
}
export function CompanySearch({
  symbol,
  at,
  documents,
  onOpen,
}: {
  symbol: string;
  at: string | undefined;
  documents: { id: string; form: string }[];
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [mode, setMode] = useState('auto'),
    [form, setForm] = useState(''),
    [source, setSource] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [allRevisions, setAllRevisions] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [result, setResult] = useState<SearchResponse | null>(null),
    [error, setError] = useState(''),
    [indexError, setIndexError] = useState(''),
    [searching, setSearching] = useState(false),
    [indexing, setIndexing] = useState(false);
  const scope = JSON.stringify([
    symbol,
    at,
    query,
    mode,
    form,
    source,
    from,
    to,
    allRevisions,
  ]);
  const selected = useRef(scope);
  selected.current = scope;
  const requestId = useRef(0);
  const documentsKey = documents.map((d) => d.id).join(',');
  const companyKey = symbol + (at ?? '');
  const company = useRef(companyKey);
  company.current = companyKey;
  async function refresh() {
    const key = companyKey,
      next = await request<Status>(
        `/search/status?symbol=${encodeURIComponent(symbol)}${at ? '&at=' + encodeURIComponent(at) : ''}`,
      );
    if (company.current === key) setStatus(next);
  }
  useEffect(() => {
    setResult(null);
    setError('');
  }, [scope]);
  useEffect(() => {
    let live = true;
    setStatus(null);
    setIndexError('');
    const update = () =>
      request<Status>(
        `/search/status?symbol=${encodeURIComponent(symbol)}${at ? '&at=' + encodeURIComponent(at) : ''}`,
      )
        .then((next) => {
          if (live) setStatus(next);
        })
        .catch((e) => {
          if (live) setIndexError(String(e));
        });
    void update();
    return () => {
      live = false;
    };
  }, [symbol, at, documentsKey]);
  useEffect(() => {
    if (status?.job?.status !== 'running') return;
    let live = true;
    const timer = setInterval(() => {
      void request<Status>(
        `/search/status?symbol=${encodeURIComponent(symbol)}${at ? '&at=' + encodeURIComponent(at) : ''}`,
      )
        .then((next) => {
          if (live) setStatus(next);
        })
        .catch((e) => {
          if (live) setIndexError(String(e));
        });
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [status?.job?.status, symbol, at]);
  const running = indexing || status?.job?.status === 'running';
  return (
    <section className="company-search" aria-label="Company evidence search">
      <div className="company-search-heading">
        <div>
          <h2>Search company evidence</h2>
          <p>
            Ask a question, find a reported fact, or trace a risk to its source.
          </p>
        </div>
        <span className="research-tag">{symbol}</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (searching) return;
          const id = ++requestId.current,
            key = scope;
          setSearching(true);
          setError('');
          setResult(null);
          void request<SearchResponse>('/search', {
            version: 2,
            symbol,
            query,
            ...(at ? { at } : {}),
            ...(mode === 'auto' ? {} : { mode }),
            ...(form ? { forms: [form] } : {}),
            ...(source ? { source } : {}),
            ...(from ? { publishedFrom: from } : {}),
            ...(to ? { publishedTo: to } : {}),
            revisions: allRevisions ? 'all' : 'latest',
            limit: 12,
          })
            .then((next) => {
              if (selected.current === key) setResult(next);
            })
            .catch((e) => {
              if (selected.current === key) setError(String(e));
            })
            .finally(() => {
              if (requestId.current === id) setSearching(false);
              void refresh().catch(() => undefined);
            });
        }}
      >
        <div className="company-search-query">
          <label>
            Search stored evidence
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={500}
              placeholder="Could this company run out of cash?"
            />
          </label>
          <button disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search documents'}
          </button>
        </div>
        <div className="company-search-examples">
          Try{' '}
          {[
            'What could hurt future sales?',
            'Has management changed its outlook?',
            'How much cash did operations generate?',
          ].map((text) => (
            <button
              type="button"
              className="research-link"
              key={text}
              onClick={() => setQuery(text)}
            >
              {text}
            </button>
          ))}
        </div>
        <details>
          <summary>Search options</summary>
          <div className="company-search-filters">
            <label>
              Search method
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="auto">Automatic · hybrid when indexed</option>
                <option value="hybrid">Hybrid · words and meaning</option>
                <option value="keyword">Keyword · words and phrases</option>
                <option value="semantic">Semantic · meaning</option>
              </select>
            </label>
            <label>
              Document type
              <select value={form} onChange={(e) => setForm(e.target.value)}>
                <option value="">All document types</option>
                {[...new Set(documents.map((d) => d.form))].sort().map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              Source
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">All sources</option>
                <option value="sec">SEC</option>
                <option value="upload">Uploaded documents</option>
                <option value="ir">Company / investor relations</option>
                <option value="fund">ETF / fund documents</option>
                <option value="occ">Options notices</option>
                <option value="macro">Economic releases</option>
                <option value="news">Financial news</option>
                <option value="fixture">Synthetic fixtures</option>
              </select>
            </label>
            <label>
              Published from
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              Published through
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label className="company-search-checkbox">
              <input
                type="checkbox"
                checked={allRevisions}
                onChange={(e) => setAllRevisions(e.target.checked)}
              />
              Include superseded revisions
            </label>
          </div>
          <p className="muted-label">
            Exact phrases use quotes; OR and minus exclusions work in Keyword
            mode. Publication filters exclude undated documents. The evidence
            cutoff above always applies.
          </p>
        </details>
      </form>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <div className="company-search-index">
        <div>
          <strong>Meaning-based search</strong>
          <p className="muted-label">
            {status
              ? `${status.coverage.indexed} / ${status.coverage.total} eligible passages indexed`
              : 'Checking index…'}
            {running
              ? ` · Processing ${status?.job?.processed ?? 0} passages…`
              : ''}
          </p>
        </div>
        <button
          disabled={!status?.configured || !status.coverage.pending || running}
          onClick={() => {
            const key = companyKey;
            setIndexing(true);
            setIndexError('');
            void request('/search/index', {
              version: 1,
              symbol,
              idempotencyKey: crypto.randomUUID(),
            })
              .then(() => refresh())
              .catch((e) => {
                if (company.current === key) setIndexError(String(e));
              })
              .finally(() => setIndexing(false));
          }}
        >
          {running
            ? 'Indexing…'
            : status?.coverage.indexed
              ? 'Update search index'
              : 'Build search index'}
        </button>
      </div>
      <p className="muted-label">
        {status?.provider === 'openai'
          ? 'Indexing sends document passages to OpenAI; semantic queries send the question. Cached text is reused. Small API usage charges apply.'
          : status?.provider === 'fixture'
            ? 'Offline demo: synthetic embeddings exercise search mechanics; they do not measure real semantic accuracy.'
            : 'Configure the backend inference provider to enable semantic indexing.'}{' '}
        {status && (
          <>
            Today: estimated USD{' '}
            {status.usage.estimatedCost
              .replace(/(\.\d*?)0+$/, '$1')
              .replace(/\.$/, '')}
            {status.usage.uncertain ? ' (includes uncertain requests)' : ''}.
          </>
        )}
      </p>
      {(indexError || status?.job?.error) && (
        <p role="alert" className="notice">
          {indexError || status?.job?.error} Completed passages are retained.
        </p>
      )}
      {result && (
        <div aria-live="polite" className="company-search-results">
          <div className="company-search-result-heading">
            <strong>
              {result.hits.length} matching{' '}
              {result.hits.length === 1 ? 'passage' : 'passages'} ·{' '}
              {result.mode}
            </strong>
            {result.hits.length > 0 && (
              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('m2d:research-discuss', {
                      detail: `Answer this research question about ${symbol}: ${query}\nUse these search filters: ${JSON.stringify({ ...(at ? { at } : {}), mode: result.mode, forms: form ? [form] : [], source: source || undefined, publishedFrom: from || undefined, publishedTo: to || undefined, revisions: allRevisions ? 'all' : 'latest' })}. Read the matching evidence and cite the source passages. Explain uncertainties and risks.`,
                    }),
                  )
                }
              >
                Ask Agent about results
              </button>
            )}
          </div>
          {result.warnings.map((w) => (
            <p className="muted-label" key={w}>
              {w}
            </p>
          ))}
          {result.hits.map((hit) => (
            <article
              className="research-card company-search-hit"
              key={`${hit.document_id}:${hit.chunk_index}`}
            >
              <div className="company-search-hit-meta">
                <span>
                  {hit.form} · {hit.provider} · revision {hit.revision}
                </span>
                <span>{hit.matches.join(' + ')} match</span>
              </div>
              <h3>
                <button
                  className="research-link"
                  onClick={() => onOpen(hit.document_id)}
                >
                  {hit.title} ·{' '}
                  {hit.page
                    ? `page ${hit.page}`
                    : `passage ${hit.chunk_index + 1}`}
                </button>
              </h3>
              <p>{hit.text}</p>
              <small>
                Published {date(hit.published_at)} · Available{' '}
                {date(hit.available_at)} Vancouver
              </small>
              <Link href={hit.citation}>Open cited passage ↗</Link>
            </article>
          ))}
          <p className="muted-label">
            Rank measures relevance, not truth or investment confidence. Source
            statements can conflict; inspect their dates and context.
          </p>
        </div>
      )}
    </section>
  );
}
