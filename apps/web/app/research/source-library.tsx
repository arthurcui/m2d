'use client';
import { useEffect, useRef, useState } from 'react';
type Kind = 'ir' | 'fund' | 'occ' | 'macro' | 'news' | 'analyst';
type Link = { symbol: string; kind: Kind; name: string; url: string };
type Entry = Link & {
  id: string;
  note?: string;
  configured?: boolean;
  created_at?: string;
};
type Catalog = { mode: 'fixture' | 'live'; saved: Entry[]; presets: Entry[] };
const labels: Record<Kind, string> = {
  ir: 'Company / investor relations',
  fund: 'ETF / fund documents',
  occ: 'Options notices',
  macro: 'Economic releases',
  news: 'Financial news',
  analyst: 'Analyst Research',
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/research/sources${path}`, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = (await response.json()) as {
    data: T;
    error?: { message: string };
  };
  if (!response.ok)
    throw new Error(value.error?.message ?? 'Source request failed.');
  return value.data;
}
const linkOf = ({ symbol, kind, name, url }: Link): Link => ({
  symbol,
  kind,
  name,
  url,
});
export function SourceLibrary({
  symbol,
  blocked,
  historical,
  onImport,
}: {
  symbol: string;
  blocked: boolean;
  historical: boolean;
  onImport: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [kind, setKind] = useState<Kind>('ir');
  const [discovered, setDiscovered] = useState<{
    source: Link;
    links: { url: string; title: string }[];
  } | null>(null);
  const selected = useRef(symbol);
  selected.current = symbol;
  async function refresh() {
    const requested = symbol;
    const data = await api<Catalog>(`?symbol=${encodeURIComponent(symbol)}`);
    if (selected.current === requested) setCatalog(data);
  }
  useEffect(() => {
    setCatalog(null);
    setDiscovered(null);
    setError('');
    setNotice('');
    if (symbol) void refresh().catch((e) => setError(String(e)));
  }, [symbol]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Source request failed.');
    } finally {
      setBusy(false);
    }
  }
  const disabled = blocked || busy || historical;
  async function fetchSource(input: { preset?: string; link?: Link }) {
    const job = await api<{ id: string; status: string }>('/import', {
      version: 1,
      symbol,
      idempotencyKey: crypto.randomUUID(),
      ...input,
    });
    onImport(job.id);
  }
  function card(entry: Entry, preset: boolean) {
    const input = preset ? { preset: entry.id } : { link: linkOf(entry) };
    return (
      <article className="research-source-card" key={entry.id}>
        <span className="muted-label">{labels[entry.kind]}</span>
        <h3>{entry.name}</h3>
        <a href={entry.url} target="_blank" rel="noreferrer">
          {new URL(entry.url).hostname}
        </a>
        <p>
          {entry.note ??
            'Saved by you for this company. Verify the publisher and document relevance.'}
        </p>
        <div className="research-source-actions">
          <button
            disabled={disabled || entry.configured === false}
            onClick={() => void act(() => fetchSource(input))}
          >
            {entry.id === 'massive-news'
              ? 'Fetch news summaries'
              : 'Import page / feed'}
          </button>
          {entry.id !== 'massive-news' && (
            <button
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  const requested = symbol;
                  const data = await api<{
                    links: { url: string; title: string }[];
                  }>('/discover', { version: 1, symbol, ...input });
                  if (selected.current === requested) {
                    setDiscovered({ source: linkOf(entry), links: data.links });
                    if (!data.links.length)
                      setNotice(
                        'No document links were found. Paste a direct public document link, or upload its PDF/text.',
                      );
                  }
                })
              }
            >
              Browse documents
            </button>
          )}
          {!preset && (
            <button
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await api('/remove', { version: 1, id: entry.id });
                  await refresh();
                  setNotice(
                    'Saved link removed. Imported documents and history remain.',
                  );
                })
              }
            >
              Remove link
            </button>
          )}
        </div>
        {entry.configured === false && (
          <p className="muted-label">
            Configure the backend Massive key to enable this source.
          </p>
        )}
      </article>
    );
  }
  return (
    <details className="research-sources">
      <summary>
        Sources · company reports, funds, options notices, economic releases and
        news
      </summary>
      <p>
        Fetch public evidence for <strong>{symbol}</strong>, then search it or
        discuss it with Agent. Each import preserves the source and observation
        time.
      </p>
      {catalog?.mode === 'fixture' && (
        <p className="notice">
          Offline source mode · imports and document links are synthetic
          examples.
        </p>
      )}
      {catalog?.mode === 'live' && (
        <p className="muted-label">
          Live public sources · imports retrieve the websites shown below.
        </p>
      )}
      {historical && (
        <p className="notice">
          Switch to Current view before retrieving new evidence.
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Retrieving source information…</p>}
      <div className="research-source-grid">
        {catalog?.saved.map((e) => card(e, false))}
        {catalog?.presets.map((e) => card(e, true))}
      </div>
      {discovered && (
        <section
          className="research-discovered"
          aria-label="Discovered source documents"
        >
          <h3>Documents from {discovered.source.name}</h3>
          <p className="muted-label">
            Choose the document for your company, fund or exact option contract.
            Directory links can cover other securities.
          </p>
          {discovered.links.map((link) => (
            <div key={link.url}>
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.title}
              </a>
              <button
                disabled={disabled}
                onClick={() =>
                  void act(() =>
                    fetchSource({
                      link: {
                        ...discovered.source,
                        name: link.title.slice(0, 150),
                        url: link.url,
                      },
                    }),
                  )
                }
              >
                Import document
              </button>
            </div>
          ))}
        </section>
      )}
      <details className="research-add-source">
        <summary>Add a company, fund, notice or feed link</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api('', { version: 1, symbol, kind, name, url });
              await refresh();
              setName('');
              setUrl('');
              setNotice(
                'Source saved. Choose Import or Browse documents to retrieve it.',
              );
            });
          }}
        >
          <label>
            Source category
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              {Object.entries(labels).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source name
            <input
              required
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company investor relations"
            />
          </label>
          <label>
            Public document or feed URL
            <input
              required
              type="url"
              maxLength={2000}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <button disabled={disabled || !name.trim() || !url.trim()}>
            Save source
          </button>
        </form>
      </details>
      <p className="muted-label">
        Imports are snapshots, not continuous monitoring. News summaries are not
        full articles. Audio, video and scanned PDFs are not transcribed.
      </p>
    </details>
  );
}
