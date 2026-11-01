'use client';
import { useEffect, useRef, useState } from 'react';
import { SourceLibrary } from './source-library';
import {
  researchRequest,
  OperationFeedback,
  type ImportResult,
  type Operation,
} from './import-feedback';
export function AddResearch({
  symbol,
  open,
  onClose,
  historical,
  activity,
  provider,
  configured,
  job,
  onJob,
  onActivity,
  onComplete,
  onOpen,
  onSearch,
}: {
  symbol: string;
  open: boolean;
  onClose: () => void;
  historical: boolean;
  activity: boolean;
  provider: string;
  configured: boolean;
  job: string | null;
  onJob: (id: string | null) => void;
  onActivity: (v: boolean) => void;
  onComplete: () => Promise<void>;
  onOpen: (id: string) => void;
  onSearch: () => void;
}) {
  const [method, setMethod] = useState('upload');
  const [category, setCategory] = useState('upload');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(''),
    [text, setText] = useState(''),
    [sourceUrl, setSourceUrl] = useState(''),
    [published, setPublished] = useState('');
  const [operations, setOperations] = useState<Record<string, Operation>>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false),
    requests = useRef(new Map<string, { signature: string; id: string }>());
  const pending = useRef('recovered');
  const fileInput = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ onComplete, onActivity, onJob });
  callbacks.current = { onComplete, onActivity, onJob };
  const slot = (key: string) => `${symbol}:${key}`;
  const operation = (key: string) => operations[slot(key)];
  const update = (key: string, value: Operation) =>
    setOperations((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    if (!job) return;
    lock.current = true;
    setBusy(true);
    callbacks.current.onActivity(true);
    let live = true,
      checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const r = await researchRequest<ImportResult>(`/imports/${job}`);
        if (!live) return;
        if (r.status === 'running') {
          update(pending.current, {
            state: 'working',
            message:
              'Processing documents… Downloads and extraction may take a moment.',
          });
          return;
        }
        update(
          pending.current,
          r.status === 'completed'
            ? {
                state: 'done',
                message:
                  r.added_count === null
                    ? `Import complete · ${r.document_ids.length} documents.`
                    : r.added_count === 0
                      ? `Already saved · ${r.reused_count} document${r.reused_count === 1 ? '' : 's'} reused · ${r.passage_count} searchable passages.`
                      : `Imported ${r.added_count} new document${r.added_count === 1 ? '' : 's'} · ${r.reused_count} already saved · ${r.passage_count} searchable passages.`,
                result: r,
              }
            : {
                state: 'error',
                message: r.error ?? 'Import interrupted. Retry when ready.',
              },
        );
        requests.current.delete(pending.current);
        lock.current = false;
        setBusy(false);
        callbacks.current.onActivity(false);
        callbacks.current.onJob(null);
        void callbacks.current.onComplete().catch(() =>
          update(pending.current, {
            state: 'error',
            message:
              'Import finished, but the document list could not reload. Reload the page to refresh the list.',
            result: r,
          }),
        );
      } catch (e) {
        if (live)
          update(pending.current, {
            state: 'working',
            message: `Could not check progress; retrying. ${e instanceof Error ? e.message : ''}`,
          });
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [job]);
  const blocked = busy || !!job || historical || !symbol;
  async function run(key: string, path: string, body: Record<string, unknown>) {
    if (lock.current || historical || !symbol) return;
    lock.current = true;
    setBusy(true);
    onActivity(true);
    const target = slot(key);
    pending.current = target;
    update(target, { state: 'working', message: 'Starting import…' });
    const signature = JSON.stringify({ path, body });
    let request = requests.current.get(target);
    if (!request || request.signature !== signature) {
      request = { signature, id: crypto.randomUUID() };
      requests.current.set(target, request);
    }
    try {
      const r = await researchRequest<{ id: string }>(path, {
        version: 1,
        ...body,
        idempotencyKey: request.id,
      });
      onJob(r.id);
    } catch (e) {
      update(target, {
        state: 'error',
        message: e instanceof Error ? e.message : 'Import failed.',
      });
      lock.current = false;
      setBusy(false);
      onActivity(false);
    }
  }
  async function upload(pasted: boolean) {
    if (lock.current || blocked) return;
    const key = pasted ? 'paste' : 'upload';
    // Capture immutable input before FileReader; a second click cannot start another read.
    lock.current = true;
    setBusy(true);
    onActivity(true);
    update(slot(key), {
      state: 'working',
      message: pasted ? 'Preparing text…' : 'Reading selected file…',
    });
    try {
      const source = pasted
        ? new File([text], `${title.trim()}.txt`, { type: 'text/plain' })
        : file;
      if (!source) throw new Error('Choose a file.');
      if (source.size > 12 * 1024 * 1024)
        throw new Error('Document limit is 12 MiB.');
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.onerror = () => reject(new Error('File could not be read.'));
        reader.readAsDataURL(source);
      });
      lock.current = false;
      await run(key, '/upload', {
        symbol,
        category,
        name: source.name,
        contentBase64,
        ...(pasted
          ? {
              title: title.trim(),
              ...(sourceUrl ? { sourceUrl } : {}),
              ...(published
                ? { publishedAt: new Date(`${published}Z`).toISOString() }
                : {}),
            }
          : {}),
      });
    } catch (e) {
      update(slot(key), {
        state: 'error',
        message: e instanceof Error ? e.message : 'Could not prepare document.',
      });
      lock.current = false;
      setBusy(false);
      onActivity(false);
    }
  }
  return (
    <section
      hidden={!open}
      className="add-research-panel"
      aria-label="Add research"
    >
      <div className="research-heading">
        <div>
          <h2>Add research</h2>
          <p>
            Evidence for <strong>{symbol || 'choose a company'}</strong>
          </p>
        </div>
        <button onClick={onClose}>Close add research</button>
      </div>
      {(busy || activity) && (
        <p role="status">
          {job
            ? 'Processing your import… Results will appear beside its source.'
            : 'Working on your request…'}
        </p>
      )}
      {historical && (
        <p className="notice">Switch to Current view before adding evidence.</p>
      )}
      <div className="research-methods" aria-label="Research input method">
        {[
          ['upload', 'Upload file'],
          ['paste', 'Paste text'],
          ['url', 'From URL'],
          ['suggested', 'Suggested sources'],
        ].map(([id, label]) => (
          <button
            key={id}
            disabled={busy || activity}
            aria-pressed={method === id}
            onClick={() => setMethod(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      <div hidden={!['upload', 'paste'].includes(method)}>
        <label>
          Document category
          <select
            value={category}
            disabled={busy}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="upload">Company / fund document</option>
            <option value="analyst">Analyst Research</option>
          </select>
        </label>
        <div hidden={method !== 'upload'} className="research-input-form">
          <label>
            Upload a company or fund document
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.txt"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <p className="muted-label">
            Text-based PDF or UTF-8 text · up to 12 MiB / 200 PDF pages
          </p>
          <button
            disabled={blocked || !file}
            onClick={() => void upload(false)}
          >
            Upload document
          </button>
          <OperationFeedback operation={operation('upload')} onOpen={onOpen} />
        </div>
        <form
          hidden={method !== 'paste'}
          className="research-input-form"
          onSubmit={(e) => {
            e.preventDefault();
            void upload(true);
          }}
        >
          <label>
            Document title
            <input
              required
              maxLength={176}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Research text
            <textarea
              aria-label="Research text"
              required
              rows={8}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label>
            Source URL (optional)
            <input
              type="url"
              value={sourceUrl}
              disabled={busy}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </label>
          <label>
            Publication time (UTC, optional)
            <input
              type="datetime-local"
              value={published}
              disabled={busy}
              onChange={(e) => setPublished(e.target.value)}
            />
          </label>
          <button disabled={blocked || !title.trim() || !text.trim()}>
            Import pasted text
          </button>
          <OperationFeedback operation={operation('paste')} onOpen={onOpen} />
        </form>
      </div>
      <div hidden={method !== 'suggested'}>
        <article className="research-source-card">
          <h3>
            {provider === 'fixture' ? 'Demo reports' : 'SEC company reports'}
          </h3>
          <p>
            Latest two supported reports and reported financial history. For
            ETFs, use fund documents.
          </p>
          <button
            disabled={blocked || !configured}
            onClick={() => void run('sec', '/import', { symbol })}
          >
            {provider === 'fixture'
              ? 'Load demo reports'
              : 'Retrieve SEC reports'}
          </button>
          <OperationFeedback operation={operation('sec')} onOpen={onOpen} />
        </article>
      </div>
      <SourceLibrary
        symbol={symbol}
        mode={method}
        blocked={blocked}
        onActivity={onActivity}
        runImport={run}
        operation={operation}
        onOpen={onOpen}
      />
      <OperationFeedback operation={operations.recovered} onOpen={onOpen} />
      {Object.entries(operations).some(
        ([key, o]) => key.startsWith(`${symbol}:`) && o.state === 'done',
      ) && (
        <div className="research-actions">
          <button
            disabled={busy || activity}
            onClick={() => {
              setMethod('upload');
              setFile(null);
              setTitle('');
              setText('');
              setSourceUrl('');
              setPublished('');
              if (fileInput.current) fileInput.current.value = '';
              setOperations((old) => {
                const next = { ...old };
                delete next[slot('upload')];
                delete next[slot('paste')];
                return next;
              });
            }}
          >
            Add another
          </button>
          <button onClick={onSearch}>Search this company</button>
        </div>
      )}
    </section>
  );
}
