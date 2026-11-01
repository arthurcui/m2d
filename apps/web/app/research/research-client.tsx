'use client';
import { useEffect, useState, useRef } from 'react';
import { CompanySearch } from './company-search';
import { SourceLibrary } from './source-library';
import { CompanyCharts } from './company-charts';
import { useSearchParams } from 'next/navigation';
export type ResearchContext = { symbol: string; at?: string };
type Doc = {
  id: string;
  symbol: string;
  title: string;
  form: string;
  provider: string;
  available_at: string;
  published_at: string | null;
  observed_at: string;
  hash: string;
  revision: number;
  url: string | null;
};
type Passage = { index: number; page: number | null; text: string };
type Document = Doc & {
  analyst?: {
    version: string;
    fields: {
      field: string;
      excerpts: { text: string; chunkIndex: number; page: number | null }[];
    }[];
  } | null;
  chunks: Passage[];
  findings: {
    id: string;
    claim: string;
    category: string;
    chunk_index: number;
  }[];
};
type Import = {
  id: string;
  symbol: string;
  status: string;
  error: string | null;
  document_ids: string[];
};
type Overview = {
  provider: string;
  configured: boolean;
  companies: { symbol: string; name: string; documents: number }[];
  imports: Import[];
};
type Fact = {
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
type Comparison = {
  before: Doc;
  after: Doc;
  removed: Passage[];
  added: Passage[];
  truncated: boolean;
  method: string;
};
async function api<T>(path: string, body?: unknown): Promise<T> {
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
  const data = (await r.json()) as { data: T; error?: { message: string } };
  if (!r.ok) throw new Error(data.error?.message ?? 'Research request failed.');
  return data.data;
}
function time(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Vancouver',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Not supplied';
}
export function ResearchClient({
  active,
  onContext,
}: {
  active: boolean;
  onContext: (c: ResearchContext | null) => void;
}) {
  const [uploadCategory, setUploadCategory] = useState<'upload' | 'analyst'>(
    'upload',
  );
  const [loadedSelection, setLoadedSelection] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null),
    [symbol, setSymbol] = useState(''),
    [companyInput, setCompanyInput] = useState(''),
    [at, setAt] = useState(''),
    [documents, setDocuments] = useState<Doc[]>([]),
    [facts, setFacts] = useState<Fact[]>([]),
    [document, setDocument] = useState<Document | null>(null),
    [before, setBefore] = useState(''),
    [after, setAfter] = useState(''),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<string | null>(null),
    [file, setFile] = useState<File | null>(null),
    [holdings, setHoldings] = useState<string[]>([]);
  const documentId = useSearchParams().get('document');
  const cutoff = at ? new Date(`${at}Z`).toISOString() : undefined;
  const suffix = cutoff ? `?at=${encodeURIComponent(cutoff)}` : '';
  const selection = useRef('');
  selection.current = symbol + suffix;
  async function refresh() {
    const requestedSelection = symbol + suffix;
    setOverview(await api<Overview>(''));
    if (symbol) {
      const result = await api<{ documents: Doc[]; facts: Fact[] }>(
        `/companies/${symbol}${suffix}`,
      );
      if (selection.current === requestedSelection) {
        setDocuments(result.documents);
        setFacts(result.facts);
        setLoadedSelection(requestedSelection);
      }
    }
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research request failed.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!active) return;
    void api<Overview>('')
      .then((o) => {
        setOverview(o);
        const pending = o.imports.find((i) => i.status === 'running');
        if (pending) setJob(pending.id);
      })
      .catch((e) => setError(String(e)));
    void fetch('/api/v1/portfolio/overview')
      .then((r) => r.json())
      .then(
        (v: {
          data?: {
            state?: {
              positions?: {
                instrument: { symbol?: string; underlying?: string };
              }[];
            };
          };
        }) =>
          setHoldings(
            [
              ...new Set(
                (v.data?.state?.positions ?? [])
                  .map(
                    (p) => p.instrument.underlying ?? p.instrument.symbol ?? '',
                  )
                  .filter(Boolean),
              ),
            ].sort(),
          ),
      )
      .catch(() => undefined);
  }, [active]);
  useEffect(() => {
    onContext(symbol ? { symbol, ...(cutoff ? { at: cutoff } : {}) } : null);
  }, [symbol, cutoff, onContext]);
  useEffect(() => {
    setDocument((current) =>
      current?.symbol === symbol && (!cutoff || current.available_at <= cutoff)
        ? current
        : null,
    );
    setComparison(null);
    setBefore('');
    setAfter('');
    if (!symbol) {
      setDocuments([]);
      setFacts([]);
      return;
    }
    let live = true;
    void api<{ documents: Doc[]; facts: Fact[] }>(
      `/companies/${symbol}${suffix}`,
    )
      .then((r) => {
        if (live) {
          setDocuments(r.documents);
          setFacts(r.facts);
          setLoadedSelection(symbol + suffix);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [symbol, suffix]);
  useEffect(() => {
    if (!job) return;
    let stopped = false;
    const timer = setInterval(() => {
      void api<Import>(`/imports/${job}`)
        .then(async (r) => {
          if (stopped || r.status === 'running') return;
          if (r.error) setError(r.error);
          try {
            await refresh();
          } catch (e) {
            if (!stopped)
              setError(
                e instanceof Error ? e.message : 'Research refresh failed.',
              );
          } finally {
            setJob(null);
          }
        })
        .catch((e) => {
          if (!stopped) setError(String(e));
        });
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job, symbol, suffix]);
  useEffect(() => {
    if (!active) return;
    const id = documentId;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
    void api<Document>(`/documents/${id}${suffix}`)
      .then((d) => {
        setSymbol(d.symbol);
        setCompanyInput(d.symbol);
        setDocument(d);
        requestAnimationFrame(() =>
          window.document
            .getElementById(
              window.location.hash.slice(1) || 'research-document',
            )
            ?.scrollIntoView({ block: 'start' }),
        );
      })
      .catch((e) => setError(String(e)));
  }, [active, documentId, suffix]);
  async function openDoc(id: string) {
    setDocument(await api<Document>(`/documents/${id}${suffix}`));
    requestAnimationFrame(() =>
      window.document
        .getElementById('research-document')
        ?.scrollIntoView({ block: 'start' }),
    );
  }
  function discuss(message: string) {
    window.dispatchEvent(
      new CustomEvent('m2d:research-discuss', { detail: message }),
    );
  }
  return (
    <div hidden={!active} className="research-page">
      <div className="eyebrow">MOTIVE · EVIDENCE</div>
      <h1>Research</h1>
      <p className="intro">
        Understand what changed, inspect the evidence, and discuss the
        implications with Agent.
      </p>
      <section className="research-toolbar" aria-label="Research selection">
        <label>
          Company name or underlying ticker
          <input
            aria-label="Research ticker"
            list="research-tickers"
            value={companyInput}
            maxLength={150}
            placeholder="e.g. TSLA"
            onChange={(e) => {
              const value = e.target.value;
              setCompanyInput(value);
              const known = overview?.companies.find(
                (c) =>
                  c.name.toLowerCase() === value.toLowerCase() ||
                  c.symbol === value.toUpperCase(),
              );
              setSymbol(
                known?.symbol ??
                  (/^[A-Z0-9.-]{1,24}$/i.test(value)
                    ? value.toUpperCase()
                    : ''),
              );
            }}
          />
          <datalist id="research-tickers">
            {[
              ...new Set([
                ...holdings,
                ...(overview?.companies ?? []).map((c) => c.symbol),
              ]),
            ].map((s) => (
              <option
                key={s}
                value={s}
                label={overview?.companies.find((c) => c.symbol === s)?.name}
              />
            ))}
            {(overview?.companies ?? [])
              .filter((c) => c.name !== c.symbol)
              .map((c) => (
                <option
                  key={`name:${c.symbol}`}
                  value={c.name}
                  label={c.symbol}
                />
              ))}
          </datalist>
        </label>
        <label>
          Evidence available by (UTC)
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => {
              setAt(e.target.value);
              setDocument(null);
            }}
          />
        </label>
        <button onClick={() => setAt('')} disabled={!at}>
          Current view
        </button>
        <button
          disabled={!symbol || busy || !!job || !overview?.configured}
          onClick={() =>
            void action(async () => {
              const r = await api<Import>('/import', {
                version: 1,
                symbol,
                idempotencyKey: crypto.randomUUID(),
              });
              setJob(r.id);
            })
          }
        >
          {overview?.provider === 'fixture'
            ? 'Load demo reports'
            : 'Retrieve SEC reports'}
        </button>
      </section>
      <p className="muted-label">
        {overview?.provider === 'fixture'
          ? 'Demo report importer · synthetic reports and figures. Public sources below have a separate live/offline setting.'
          : 'SEC source · latest two supported company reports and financial history.'}{' '}
        {overview && !overview.configured
          ? 'Configure SEC_USER_AGENT in the backend to enable SEC retrieval.'
          : ''}{' '}
        Options use their underlying company. For ETFs, use fund documents;
        corporate ratios are not fund analysis.
      </p>
      {symbol && (
        <CompanyCharts
          key={symbol}
          symbol={symbol}
          at={cutoff}
          active={active}
          facts={loadedSelection === symbol + suffix ? facts : []}
          documents={loadedSelection === symbol + suffix ? documents : []}
          onOpen={(id) => void action(() => openDoc(id))}
        />
      )}
      {symbol && (
        <SourceLibrary
          symbol={symbol}
          blocked={busy || !!job}
          historical={!!cutoff}
          onImport={setJob}
        />
      )}
      <section className="research-upload">
        <label>
          Document category
          <select
            value={uploadCategory}
            onChange={(e) =>
              setUploadCategory(e.target.value as 'upload' | 'analyst')
            }
          >
            <option value="upload">Company / fund document</option>
            <option value="analyst">Analyst Research</option>
          </select>
        </label>
        <label>
          Upload a company or fund document
          <input
            type="file"
            accept=".pdf,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button
          disabled={!symbol || !file || busy || !!job}
          onClick={() =>
            void action(async () => {
              if (!file) return;
              if (file.size > 12 * 1024 * 1024)
                throw new Error('Document limit is 12 MiB.');
              const contentBase64 = await new Promise<string>(
                (resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve(String(reader.result).split(',')[1]!);
                  reader.onerror = () =>
                    reject(new Error('File could not be read.'));
                  reader.readAsDataURL(file);
                },
              );
              const r = await api<Import>('/upload', {
                category: uploadCategory,
                version: 1,
                symbol,
                name: file.name,
                contentBase64,
                idempotencyKey: crypto.randomUUID(),
              });
              setJob(r.id);
            })
          }
        >
          Upload document
        </button>
        <span className="muted-label">
          PDF or UTF-8 text · 12 MiB · text-based PDFs up to 200 pages
        </span>
      </section>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {(job || busy) && (
        <p role="status">
          {job
            ? 'Processing research documents… Your portfolio is unchanged.'
            : 'Loading evidence…'}
        </p>
      )}
      {symbol && (
        <CompanySearch
          symbol={symbol}
          at={cutoff}
          documents={documents}
          onOpen={(id) => void action(() => openDoc(id))}
        />
      )}
      {symbol && (
        <>
          <div className="research-heading">
            <h2>{symbol} · Company timeline</h2>
            <button
              onClick={() =>
                discuss(
                  `Review the stored research for ${symbol}. What changed, why does it matter, and what are the main risks? Cite the evidence.`,
                )
              }
            >
              Discuss with Agent
            </button>
          </div>
          {!documents.length && !job && (
            <p>
              No documents are available for this company at the selected time.
              Retrieve reports or upload a document.
            </p>
          )}
          <div className="research-documents">
            {documents
              .filter((d) => d.form !== 'INDEX')
              .map((d) => (
                <article className="research-card" key={d.id}>
                  <span className="muted-label">
                    {d.form} · {d.provider} · revision {d.revision}
                  </span>
                  <h3>
                    <button
                      className="research-link"
                      onClick={() => void action(() => openDoc(d.id))}
                    >
                      {d.title}
                    </button>
                  </h3>
                  <p>
                    Published: {time(d.published_at)}
                    <br />
                    Available: {time(d.available_at)} Vancouver
                  </p>
                  <div className="research-actions">
                    <button
                      aria-pressed={before === d.id}
                      onClick={() => setBefore(d.id)}
                    >
                      Use as before
                    </button>
                    <button
                      aria-pressed={after === d.id}
                      onClick={() => setAfter(d.id)}
                    >
                      Use as after
                    </button>
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer">
                        SEC source ↗
                      </a>
                    )}
                  </div>
                </article>
              ))}
          </div>
          <div className="research-actions">
            <button
              disabled={!before || !after || before === after || busy}
              onClick={() =>
                void action(async () =>
                  setComparison(
                    await api<Comparison>('/compare', {
                      version: 1,
                      before,
                      after,
                      ...(cutoff ? { at: cutoff } : {}),
                    }),
                  ),
                )
              }
            >
              Compare selected reports
            </button>
            {before && (
              <span>
                Before: {documents.find((d) => d.id === before)?.title}
              </span>
            )}
            {after && (
              <span>After: {documents.find((d) => d.id === after)?.title}</span>
            )}
          </div>
          {comparison && (
            <section aria-label="Report comparison">
              <h2>What changed</h2>
              <p className="muted-label">
                {comparison.method}{' '}
                {comparison.truncated
                  ? 'Showing the first 20 changed passages per report. Open the reports for the complete text.'
                  : ''}
              </p>
              <div className="research-comparison">
                {(['removed', 'added'] as const).map((side, i) => (
                  <div key={side}>
                    <h3>
                      {i ? 'After' : 'Before'} ·{' '}
                      {i ? comparison.after.title : comparison.before.title}
                    </h3>
                    {comparison[side].map((c) => (
                      <blockquote key={c.index}>
                        <p>{c.text}</p>
                        <button
                          onClick={() =>
                            void action(() =>
                              openDoc(
                                i ? comparison.after.id : comparison.before.id,
                              ),
                            )
                          }
                        >
                          Open source ·{' '}
                          {c.page ? `page ${c.page}` : `passage ${c.index + 1}`}
                        </button>
                      </blockquote>
                    ))}
                    {!comparison[side].length && <p>No changed passages.</p>}
                  </div>
                ))}
              </div>
              <button
                onClick={() =>
                  discuss(
                    `Compare research documents ${comparison.before.id} and ${comparison.after.id} for ${symbol}. Explain the business, guidance and risk changes with citations, separating facts from interpretation.`,
                  )
                }
              >
                Discuss this comparison
              </button>
            </section>
          )}
          <details>
            <summary>
              Financial history · {facts.length}
              {facts.length === 500 ? '+' : ''} observations
            </summary>
            <p className="muted-label">
              Reported values, original units and periods. Multiple accessions
              may restate the same period; later values never replace earlier
              evidence. No ratios or ETF valuations are inferred.
            </p>
            <div className="research-facts">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Period</th>
                    <th>Value / unit</th>
                    <th>Filed / source</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((f) => (
                    <tr key={f.id}>
                      <td>{f.metric}</td>
                      <td>
                        {f.period_start ?? 'Instant'} → {f.period_end}
                      </td>
                      <td>
                        {f.value} {f.unit}
                      </td>
                      <td>
                        <button
                          onClick={() =>
                            void action(() => openDoc(f.document_id))
                          }
                        >
                          {f.filed} · {f.provider}
                        </button>
                        <small>{f.accession}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {document && (
        <section id="research-document" className="research-document">
          <div className="research-heading">
            <h2>{document.title}</h2>
            <button onClick={() => setDocument(null)}>Close document</button>
          </div>
          <p className="muted-label">
            {document.provider} · revision {document.revision} · available{' '}
            {time(document.available_at)} Vancouver
            <br />
            SHA-256: {document.hash}
          </p>
          <a href={`/api/v1/research/documents/${document.id}/raw`}>
            Download preserved original
          </a>
          {document.analyst && (
            <section aria-label="Analyst report details">
              <h3>Analyst Research · attributed opinions</h3>
              <p>
                Exact labelled excerpts, not verified values. Missing fields
                remain unknown; ask Agent to interpret other report formats.
              </p>
              <dl>
                {document.analyst.fields.map((f) => (
                  <div key={f.field}>
                    <dt>{f.field.replace(/([A-Z])/g, ' $1')}</dt>
                    <dd>
                      {f.excerpts.length
                        ? f.excerpts.map((e, i) => (
                            <p key={i}>
                              <a href={`#chunk-${e.chunkIndex}`}>
                                {e.text} …{' '}
                                {e.page
                                  ? `page ${e.page}`
                                  : `passage ${e.chunkIndex + 1}`}
                              </a>
                            </p>
                          ))
                        : 'Unknown · no explicit labelled excerpt found'}
                    </dd>
                  </div>
                ))}
              </dl>
              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('m2d:research-discuss', {
                      detail: `Analyze analyst report ${document.id} for ${document.symbol}. Extract publisher, analyst, date, rating, target with currency and horizon, forecasts, assumptions, catalysts and risks with citations. Mark missing fields unknown. Compare with other stored analyst reports for this company, citing each report date. Separate opinions from company facts; do not assume consensus.`,
                    }),
                  )
                }
              >
                Analyze / compare analyst reports with Agent
              </button>
            </section>
          )}
          <details>
            <summary>
              Extracted source statements · {document.findings.length}
            </summary>
            <p>
              Quoted passages selected by topic rules. These are source claims,
              not independently verified facts or AI conclusions.
            </p>
            {document.findings.map((f) => (
              <blockquote key={f.id}>
                <a href={`#chunk-${f.chunk_index}`}>
                  {f.category} · passage {f.chunk_index + 1}
                </a>
                <p>{f.claim}</p>
              </blockquote>
            ))}
          </details>
          <details open>
            <summary>Source passages</summary>
            {document.chunks.map((c) => (
              <div
                className="research-passage"
                id={`chunk-${c.index}`}
                key={c.index}
              >
                <small>
                  {c.page ? `Page ${c.page} · ` : ''}Passage {c.index + 1}
                </small>
                <p>{c.text}</p>
              </div>
            ))}
          </details>
        </section>
      )}
      <details>
        <summary>Recent imports</summary>
        {overview?.imports.map((i) => (
          <p key={i.id}>
            {i.symbol} · {i.status}
            {i.error ? ` · ${i.error}` : ''}
          </p>
        ))}
      </details>
    </div>
  );
}
