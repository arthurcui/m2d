'use client';
import { useEffect, useState, useRef } from 'react';
import { CompanySearch } from './company-search';
import { AddResearch, type ResearchImportControl } from './add-research';
import { CompanyPicker } from './company-picker';
import {
  OperationFeedback,
  importSummary,
  type Operation,
  type ImportResult,
} from './import-feedback';
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
type Import = ImportResult & { finished_at?: string | null; provider?: string };
type Overview = {
  provider: string;
  configured: boolean;
  companyChoices?: { symbol: string; hidden: boolean }[];
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
  const [tab, setTab] = useState('overview'),
    [addOpen, setAddOpen] = useState(false),
    [adding, setAdding] = useState(false),
    [comparing, setComparing] = useState(false),
    [docFilter, setDocFilter] = useState('');
  const [loadedSelection, setLoadedSelection] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null),
    [symbol, setSymbol] = useState(''),
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
    [holdings, setHoldings] = useState<string[]>([]);
  const importControl = useRef<ResearchImportControl>(null);
  const [secOperation, setSecOperation] = useState<Operation>();
  const [reportCheck, setReportCheck] = useState<{
    symbol: string;
    result: Import | null;
  } | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const savedScroll = useRef<{ element: Element; top: number } | null>(null);
  function openAdd() {
    if (!addOpen) {
      let element: Element | null = page.current?.parentElement ?? null;
      while (
        element &&
        !/(auto|scroll)/.test(getComputedStyle(element).overflowY)
      )
        element = element.parentElement;
      element ??= window.document.scrollingElement;
      if (element) savedScroll.current = { element, top: element.scrollTop };
    }
    setAddOpen(true);
    requestAnimationFrame(() =>
      page.current?.scrollIntoView({ block: 'start' }),
    );
  }
  function closeAdd() {
    setAddOpen(false);
    requestAnimationFrame(() => {
      if (savedScroll.current)
        savedScroll.current.element.scrollTop = savedScroll.current.top;
      addButton.current?.focus({ preventScroll: true });
    });
  }
  const documentId = useSearchParams().get('document');
  const lastCitation = useRef('');
  useEffect(() => {
    const openCitation = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest('a[href]')
          : null;
      if (!anchor) return;
      const url = new URL((anchor as HTMLAnchorElement).href);
      if (
        url.origin === location.origin &&
        url.pathname === '/research' &&
        /^[0-9a-f-]{36}$/.test(url.searchParams.get('document') ?? '')
      )
        setTab('documents');
    };
    window.addEventListener('click', openCitation);
    return () => window.removeEventListener('click', openCitation);
  }, []);
  const cutoff = at ? new Date(`${at}Z`).toISOString() : undefined;
  const suffix = cutoff ? `?at=${encodeURIComponent(cutoff)}` : '';
  const selection = useRef('');
  selection.current = symbol + suffix;
  async function refresh() {
    const requestedSelection = symbol + suffix;
    setOverview(await api<Overview>(''));
    if (symbol) {
      const result = await api<{
        documents: Doc[];
        facts: Fact[];
        reportCheck?: Import | null;
      }>(`/companies/${symbol}${suffix}`);
      if (selection.current === requestedSelection) {
        setDocuments(result.documents);
        setFacts(result.facts);
        setReportCheck({ symbol, result: result.reportCheck ?? null });
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
        if (pending) {
          setJob(pending.id);
          setSymbol((current) => current || pending.symbol);
        }
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
    void api<{ documents: Doc[]; facts: Fact[]; reportCheck?: Import | null }>(
      `/companies/${symbol}${suffix}`,
    )
      .then((r) => {
        if (live) {
          setDocuments(r.documents);
          setFacts(r.facts);
          setReportCheck({ symbol, result: r.reportCheck ?? null });
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
    if (!active) return;
    const id = documentId;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
    void api<Document>(`/documents/${id}${suffix}`)
      .then((d) => {
        setSymbol(d.symbol);
        setDocument(d);
        if (lastCitation.current !== id + suffix) {
          setTab('documents');
          lastCitation.current = id + suffix;
        }
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
    setTab('documents');
    setAddOpen(false);
    setDocument(await api<Document>(`/documents/${id}${suffix}`));
    requestAnimationFrame(() =>
      window.document
        .getElementById('research-document')
        ?.scrollIntoView({ block: 'start' }),
    );
  }
  const [coverage, setCoverage] = useState<{
    symbol: string;
    text: string;
  } | null>(null);
  const docKey = documents.map((d) => d.id).join(',');
  useEffect(() => {
    if (!symbol) return;
    let live = true;
    void api<{ coverage: { indexed: number; total: number } }>(
      `/search/status?symbol=${encodeURIComponent(symbol)}${cutoff ? '&at=' + encodeURIComponent(cutoff) : ''}`,
    )
      .then((r) => {
        if (live)
          setCoverage({
            symbol,
            text: `${r.coverage.indexed} / ${r.coverage.total} passages indexed`,
          });
      })
      .catch(() => {
        if (live) setCoverage({ symbol, text: 'Search coverage unavailable' });
      });
    return () => {
      live = false;
    };
  }, [symbol, cutoff, docKey, tab]);
  const visibleDocuments = loadedSelection === symbol + suffix ? documents : [];
  function discuss(message: string) {
    window.dispatchEvent(
      new CustomEvent('m2d:research-discuss', { detail: message }),
    );
  }
  const completedReport =
    reportCheck?.symbol === symbol ? reportCheck.result : null;
  const secFeedback: Operation | undefined =
    secOperation ??
    (completedReport
      ? {
          state: 'done',
          message: importSummary(completedReport),
          result: completedReport,
        }
      : undefined);
  return (
    <div ref={page} hidden={!active} className="research-page">
      <div className="eyebrow">MOTIVE · EVIDENCE</div>
      <h1>Research</h1>
      <p className="intro" hidden={addOpen}>
        Understand what changed, inspect the evidence, and discuss the
        implications with Advisor.
      </p>
      <section
        hidden={addOpen}
        className="research-toolbar"
        aria-label="Research selection"
      >
        <CompanyPicker
          companies={overview?.companies ?? []}
          portfolioSymbols={holdings}
          choices={overview?.companyChoices ?? []}
          selected={symbol}
          disabled={adding || !!job}
          onSelect={setSymbol}
          onChoicesChange={refresh}
        />
        <button ref={addButton} disabled={!symbol} onClick={openAdd}>
          Add research
        </button>
        <button
          disabled={!symbol}
          onClick={() =>
            discuss(
              `Review the stored research for ${symbol}. What changed, why does it matter, and what are the main risks? Cite the evidence.`,
            )
          }
        >
          Discuss with Advisor
        </button>
        <details className="research-history-control">
          <summary>
            Evidence as of · {at ? 'historical cutoff' : 'Latest available'}
          </summary>{' '}
          <p>
            Advanced: include only evidence available by this time. This is not
            the report period. Leave empty for all currently available evidence.
          </p>
          <label>
            Evidence available by (UTC)
            <input
              disabled={adding || !!job}
              type="datetime-local"
              value={at}
              onChange={(e) => {
                setAt(e.target.value);
                setDocument(null);
              }}
            />
          </label>
          <button onClick={() => setAt('')} disabled={!at || adding || !!job}>
            Latest available
          </button>
        </details>
      </section>
      <div
        hidden={addOpen}
        className="research-tabs"
        role="tablist"
        aria-label="Research views"
        onKeyDown={(e) => {
          const names = ['overview', 'documents', 'search'];
          const i = names.indexOf(tab);
          const next =
            e.key === 'ArrowRight'
              ? (i + 1) % 3
              : e.key === 'ArrowLeft'
                ? (i + 2) % 3
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? 2
                    : -1;
          if (next >= 0) {
            e.preventDefault();
            setTab(names[next]!);
            (
              e.currentTarget.querySelectorAll('button')[
                next
              ] as HTMLButtonElement
            ).focus();
          }
        }}
      >
        {['overview', 'documents', 'search'].map((t) => (
          <button
            role="tab"
            id={`research-tab-${t}`}
            aria-controls={`research-panel-${t}`}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            key={t}
            onClick={() => setTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {job && !addOpen && (
        <p role="status">
          Import processing…{' '}
          <button onClick={openAdd}>View import progress</button>
        </p>
      )}
      <AddResearch
        controlRef={importControl}
        onSecStatus={setSecOperation}
        symbol={symbol}
        open={addOpen}
        onClose={closeAdd}
        historical={!!cutoff}
        activity={adding}
        provider={overview?.provider ?? 'fixture'}
        configured={overview?.configured ?? false}
        job={job}
        onJob={setJob}
        onActivity={setAdding}
        onComplete={refresh}
        onOpen={(id) => void action(() => openDoc(id))}
        onSearch={() => {
          setTab('search');
          setAddOpen(false);
        }}
      />
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <section
        id="research-panel-overview"
        role="tabpanel"
        aria-labelledby="research-tab-overview"
        hidden={addOpen || tab !== 'overview'}
      >
        {!symbol && (
          <p>Choose a company to see its research and market context.</p>
        )}
        {symbol && (
          <section className="overview-reports" aria-label="Company reports">
            <div className="research-heading">
              <div>
                <h2>
                  {overview?.provider === 'fixture'
                    ? 'Demo reports'
                    : 'SEC company reports'}
                </h2>
                <p>
                  Latest filings and reported financial history. For ETFs, add
                  fund documents.
                </p>
              </div>
              <button
                disabled={adding || !!job || !!cutoff || !overview?.configured}
                onClick={() => importControl.current?.refreshSec()}
              >
                {adding && secOperation?.state === 'working'
                  ? 'Refreshing reports…'
                  : overview?.provider === 'fixture'
                    ? 'Load demo reports'
                    : 'Refresh SEC reports'}
              </button>
            </div>
            <p className="muted-label">
              Last successful check:{' '}
              {time(completedReport?.finished_at ?? null)}
              {cutoff
                ? ' · Switch to Latest available to refresh reports.'
                : ''}
            </p>
            <OperationFeedback
              operation={cutoff ? undefined : secFeedback}
              onOpen={(id) => void action(() => openDoc(id))}
            />
          </section>
        )}
        {symbol && (
          <div className="research-coverage">
            <strong>
              {visibleDocuments.filter((d) => d.form !== 'INDEX').length} saved
              {visibleDocuments.filter((d) => d.form !== 'INDEX').length === 1
                ? 'document'
                : 'documents'}
            </strong>
            <span>
              Last import:{' '}
              {time(
                overview?.imports.find(
                  (i) => i.symbol === symbol && i.status === 'completed',
                )?.finished_at ?? null,
              )}
            </span>
            <button onClick={() => setTab('search')}>
              {coverage?.symbol === symbol
                ? coverage.text
                : 'View search coverage'}
            </button>
          </div>
        )}
        {symbol && (
          <CompanyCharts
            key={symbol}
            symbol={symbol}
            at={cutoff}
            active={active && !addOpen && tab === 'overview'}
            facts={loadedSelection === symbol + suffix ? facts : []}
            documents={loadedSelection === symbol + suffix ? documents : []}
            onOpen={(id) => void action(() => openDoc(id))}
          />
        )}
        <details>
          <summary>
            Financial history · {facts.length}
            {facts.length === 500 ? '+' : ''} observations
          </summary>
          <p className="muted-label">
            Reported values, original units and periods. Multiple accessions may
            restate the same period; later values never replace earlier
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
        </details>{' '}
      </section>
      <section
        id="research-panel-search"
        role="tabpanel"
        aria-labelledby="research-tab-search"
        hidden={addOpen || tab !== 'search'}
      >
        {symbol && (
          <CompanySearch
            symbol={symbol}
            at={cutoff}
            documents={visibleDocuments}
            onOpen={(id) => void action(() => openDoc(id))}
          />
        )}
      </section>
      <section
        id="research-panel-documents"
        role="tabpanel"
        aria-labelledby="research-tab-documents"
        hidden={addOpen || tab !== 'documents'}
      >
        {symbol && (
          <>
            <div className="research-heading">
              <h2>{symbol} · Company timeline</h2>
            </div>
            {!documents.length && !job && (
              <p>
                No documents are available for this company at the selected
                time. Retrieve reports or upload a document.
              </p>
            )}
            <div className="research-actions">
              <label>
                Filter documents
                <input
                  value={docFilter}
                  onChange={(e) => setDocFilter(e.target.value)}
                  placeholder="Title, source or type"
                />
              </label>
              <button
                onClick={() => setComparing((v) => !v)}
                aria-expanded={comparing}
              >
                Compare reports
              </button>
            </div>
            <div className="research-documents">
              {visibleDocuments
                .filter(
                  (d) =>
                    d.form !== 'INDEX' &&
                    `${d.title} ${d.provider} ${d.form}`
                      .toLowerCase()
                      .includes(docFilter.toLowerCase()),
                )
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
                      {d.url && (
                        <a href={d.url} target="_blank" rel="noreferrer">
                          Original source ↗
                        </a>
                      )}
                    </div>
                  </article>
                ))}
            </div>
            <section
              hidden={!comparing}
              className="research-actions"
              aria-label="Choose reports to compare"
            >
              <label>
                Earlier report
                <select
                  value={before}
                  onChange={(e) => setBefore(e.target.value)}
                >
                  <option value="">Choose earlier report</option>
                  {visibleDocuments
                    .filter((d) => d.form !== 'INDEX')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} · revision {d.revision}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Newer report
                <select
                  value={after}
                  onChange={(e) => setAfter(e.target.value)}
                >
                  <option value="">Choose newer report</option>
                  {visibleDocuments
                    .filter((d) => d.form !== 'INDEX')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} · revision {d.revision}
                      </option>
                    ))}
                </select>
              </label>
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
                <span>
                  After: {documents.find((d) => d.id === after)?.title}
                </span>
              )}
            </section>
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
                                  i
                                    ? comparison.after.id
                                    : comparison.before.id,
                                ),
                              )
                            }
                          >
                            Open source ·{' '}
                            {c.page
                              ? `page ${c.page}`
                              : `passage ${c.index + 1}`}
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
                  remain unknown; ask Advisor to interpret other report formats.
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
                  Analyze / compare analyst reports with Advisor
                </button>
              </section>
            )}
            <details>
              <summary>
                Extracted source statements · {document.findings.length}
              </summary>
              <p>
                Quoted passages selected by topic rules. These are source
                claims, not independently verified facts or AI conclusions.
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
              {i.added_count !== null && i.added_count !== undefined
                ? ` · ${i.added_count} new / ${i.reused_count} reused`
                : ''}
              {i.error ? ` · ${i.error}` : ''}
            </p>
          ))}
        </details>
      </section>
    </div>
  );
}
