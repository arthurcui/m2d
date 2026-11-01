'use client';
import { useEffect, useRef, useState } from 'react';
import {
  researchRequest,
  OperationFeedback,
  type Operation,
} from './import-feedback';
type Kind = 'ir' | 'fund' | 'occ' | 'macro' | 'news' | 'analyst';
type Link = { symbol: string; kind: Kind; name: string; url: string };
type Entry = Link & { id: string; note?: string; configured?: boolean };
type Catalog = { mode: 'fixture' | 'live'; saved: Entry[]; presets: Entry[] };
const labels: Record<Kind, string> = {
  ir: 'Company / investor relations',
  fund: 'ETF / fund documents',
  occ: 'Options notices',
  macro: 'Economic releases',
  news: 'Financial news',
  analyst: 'Analyst Research',
};
export function SourceLibrary({
  symbol,
  mode,
  blocked,
  onActivity,
  runImport,
  operation,
  onOpen,
}: {
  symbol: string;
  mode: string;
  blocked: boolean;
  onActivity: (v: boolean) => void;
  runImport: (
    key: string,
    path: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
  operation: (key: string) => Operation | undefined;
  onOpen: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [kind, setKind] = useState<Kind>('ir');
  const [local, setLocal] = useState<Record<string, Operation>>({});
  const [found, setFound] = useState<
    Record<string, { url: string; title: string }[]>
  >({});
  const selected = useRef(symbol);
  selected.current = symbol;
  const lock = useRef(false);
  const key = (s: string) => `${symbol}:${s}`;
  const state = (s: string) => local[key(s)];
  async function refresh() {
    const requested = symbol;
    const data = await researchRequest<Catalog>(
      `/sources?symbol=${encodeURIComponent(symbol)}`,
    );
    if (selected.current === requested) setCatalog(data);
  }
  useEffect(() => {
    setCatalog(null);
    setError('');
    if (symbol) void refresh().catch((e) => setError(String(e)));
  }, [symbol]);
  const disabled = blocked || busy;
  async function act(slot: string, fn: () => Promise<string>) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onActivity(true);
    const target = key(slot);
    setLocal((old) => ({
      ...old,
      [target]: {
        state: 'working',
        message: slot.startsWith('browse')
          ? 'Finding document links…'
          : 'Saving source…',
      },
    }));
    try {
      const message = await fn();
      setLocal((old) => ({ ...old, [target]: { state: 'done', message } }));
    } catch (e) {
      setLocal((old) => ({
        ...old,
        [target]: {
          state: 'error',
          message: e instanceof Error ? e.message : 'Source request failed.',
        },
      }));
    } finally {
      lock.current = false;
      setBusy(false);
      onActivity(false);
    }
  }
  function browse(slot: string, input: Record<string, unknown>) {
    const target = key(slot);
    return act(`browse:${slot}`, async () => {
      const data = await researchRequest<{
        links: { url: string; title: string }[];
      }>('/sources/discover', { version: 1, symbol, ...input });
      setFound((old) => ({ ...old, [target]: data.links }));
      return data.links.length
        ? `Found ${data.links.length} document${data.links.length === 1 ? '' : 's'}. Choose a relevant document below.`
        : 'No document links found. Import this page or use a direct document URL.';
    });
  }
  function results(slot: string, source: Link) {
    return (
      <>
        <OperationFeedback
          operation={state(`browse:${slot}`)}
          onOpen={onOpen}
        />
        {found[key(slot)] && (
          <section
            className="research-discovered"
            aria-label={`Documents from ${source.name}`}
          >
            {found[key(slot)]!.map((link) => {
              const target = `link:${link.url}`;
              return (
                <div key={link.url}>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.title}
                  </a>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void runImport(target, '/sources/import', {
                        symbol,
                        link: {
                          ...source,
                          name: link.title.slice(0, 150),
                          url: link.url,
                        },
                      })
                    }
                  >
                    {operation(target)?.state === 'done'
                      ? 'Check for updates'
                      : 'Import document'}
                  </button>
                  <OperationFeedback
                    operation={operation(target)}
                    onOpen={onOpen}
                  />
                </div>
              );
            })}
          </section>
        )}
      </>
    );
  }
  function card(entry: Entry, preset: boolean) {
    const source: Link = {
      symbol,
      kind: entry.kind,
      name: entry.name,
      url: entry.url,
    };
    const input = preset ? { preset: entry.id } : { link: source };
    const slot = preset ? `preset:${entry.id}` : `link:${entry.url}`;
    return (
      <article className="research-source-card" key={entry.id}>
        <span className="muted-label">{labels[entry.kind]}</span>
        <h3>{entry.name}</h3>
        <a href={entry.url} target="_blank" rel="noreferrer">
          {new URL(entry.url).hostname}
        </a>
        <p>
          {entry.note ??
            'Saved for this company. Verify the publisher and relevance.'}
        </p>
        <div className="research-source-actions">
          <button
            type="button"
            disabled={disabled || entry.configured === false}
            onClick={() =>
              void runImport(slot, '/sources/import', { symbol, ...input })
            }
          >
            {operation(slot)?.state === 'done'
              ? 'Check for updates'
              : operation(slot)?.state === 'error'
                ? 'Retry import'
                : entry.id === 'massive-news'
                  ? 'Fetch news summaries'
                  : 'Import page / feed'}
          </button>
          {entry.id !== 'massive-news' && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void browse(slot, input)}
            >
              {state(`browse:${slot}`)?.state === 'done'
                ? 'Browse again'
                : 'Browse documents'}
            </button>
          )}
          {!preset && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act(`remove:${entry.id}`, async () => {
                  await researchRequest('/sources/remove', {
                    version: 1,
                    id: entry.id,
                  });
                  await refresh();
                  return 'Saved link removed; imported evidence is kept.';
                })
              }
            >
              Remove link
            </button>
          )}
        </div>
        <OperationFeedback operation={operation(slot)} onOpen={onOpen} />
        {results(slot, source)}
        {entry.configured === false && (
          <p className="notice">
            Configure the backend Massive key to enable this source.
          </p>
        )}
      </article>
    );
  }
  const draft: Link = { symbol, kind, name, url };
  return (
    <div
      hidden={!['url', 'suggested'].includes(mode)}
      className="research-sources"
    >
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <p className="muted-label">
          {catalog.mode === 'fixture'
            ? 'Offline source mode · synthetic examples'
            : 'Live public sources · imported snapshots, not continuous monitoring'}
        </p>
      )}
      <form
        hidden={mode !== 'url'}
        className="research-input-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runImport(`link:${url}`, '/sources/import', {
            symbol,
            link: draft,
          });
        }}
      >
        <label>
          Source category
          <select
            disabled={disabled}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {Object.entries(labels).map(([v, label]) => (
              <option key={v} value={v}>
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
            disabled={disabled}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Public document or feed URL
          <input
            type="url"
            required
            maxLength={2000}
            disabled={disabled}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </label>
        <div className="research-actions">
          <button
            type="submit"
            disabled={disabled || !name.trim() || !url.trim()}
          >
            Import this page/document
          </button>
          <button
            type="button"
            disabled={disabled || !name.trim() || !url.trim()}
            onClick={() => void browse(`link:${url}`, { link: draft })}
          >
            Find documents on this page
          </button>
          <button
            type="button"
            disabled={disabled || !name.trim() || !url.trim()}
            onClick={() =>
              void act('save', async () => {
                await researchRequest('/sources', { version: 1, ...draft });
                await refresh();
                return 'Source saved. It is available under Suggested sources; saving does not import it.';
              })
            }
          >
            Save source
          </button>
        </div>
        <OperationFeedback
          operation={operation(`link:${url}`)}
          onOpen={onOpen}
        />
        <OperationFeedback operation={state('save')} onOpen={onOpen} />
        {results(`link:${url}`, draft)}
      </form>
      <div hidden={mode !== 'suggested'}>
        <h3>Company sources</h3>
        <div className="research-source-grid">
          {catalog?.saved.map((e) => card(e, false))}
          {catalog?.presets
            .filter((e) => ['ir', 'fund', 'news'].includes(e.kind))
            .map((e) => card(e, true))}
        </div>
        <details>
          <summary>General market sources</summary>
          <p className="muted-label">
            These directories and releases are shared across companies. Choose
            relevant documents.
          </p>
          <div className="research-source-grid">
            {catalog?.presets
              .filter((e) => !['ir', 'fund', 'news'].includes(e.kind))
              .map((e) => card(e, true))}
          </div>
        </details>
      </div>
    </div>
  );
}
