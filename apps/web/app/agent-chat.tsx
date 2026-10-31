'use client';
import { useEffect, useRef, useState } from 'react';
import type { Change } from '@m2d/portfolio';
import { submitAgentOnEnter } from './agent-contexts';
type Mode = 'quick' | 'standard' | 'extensive';
type Run = {
  id: string;
  status: string;
  provider: string;
  model: string;
  analysisMode: Mode;
  policyVersion: string;
  startedAt: string;
  completeness: string;
  limitReasons: string[];
  previewId: string | null;
  estimatedCost: string | null;
  reservedCost: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    complete: boolean;
  } | null;
  effectiveLimits: {
    modelCalls: number;
    toolCalls: number;
    deadlineMs: number;
    maxOutputTokens: number;
  };
  events: { type: string; delta?: string; message?: string }[];
};
type Session = {
  revision: number;
  draft: string;
  history: { id: string; kind: string; role?: string; text?: string }[];
  runs: Run[];
};
type Preview = {
  id: string;
  status: string;
  expectedRevision: number;
  effectiveAt: string;
  expiresAt: string;
  changes: Change[];
  warnings: string[];
  operation: { note: string };
  realized: { amount: string; currency: string; quality: string }[];
};
async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const value = (await response.json()) as {
    data: T;
    error?: { message: string };
  };
  if (!response.ok) throw new Error(value.error?.message ?? 'Request failed.');
  return value.data;
}
export function AgentChat({
  context,
  label,
  active,
  disabled = false,
}: {
  context: string;
  label: string;
  active: boolean;
  disabled?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null),
    [draft, setDraft] = useState(''),
    [mode, setMode] = useState<Mode>('standard'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [live, setLive] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null);
  const revision = useRef(0),
    inFlight = useRef(false),
    draftEdited = useRef(false),
    pending = useRef<{
      idempotencyKey: string;
      message: string;
      analysisMode: Mode;
    } | null>(null),
    source = useRef<EventSource | null>(null);
  const latest = session?.runs[0],
    running = latest?.status === 'running';
  const storage = `m2d:chat-draft:${context}`;
  async function refresh() {
    const s = await api<Session>(`chat/sessions/${context}`);
    setSession(s);
    revision.current = s.revision;
    const run = s.runs.find((r) => r.previewId);
    if (run?.previewId)
      setPreview(
        await api<Preview>(`portfolio/changes/${run.previewId}/preview`),
      );
    return s;
  }
  useEffect(() => {
    if (!active || session) return;
    let gone = false;
    void Promise.all([
      api<Session>(`chat/sessions/${context}`),
      api<{ effectiveDefault: Mode }>('settings/analysis'),
    ])
      .then(([s, settings]) => {
        if (gone) return;
        setSession(s);
        revision.current = s.revision;
        setMode(settings.effectiveDefault);
        const savedRequest = localStorage.getItem(storage + ':pending');
        if (savedRequest) {
          try {
            pending.current = JSON.parse(
              savedRequest,
            ) as typeof pending.current;
          } catch {
            localStorage.removeItem(storage + ':pending');
          }
        }
        setDraft(localStorage.getItem(storage) ?? s.draft);
        const run = s.runs.find((r) => r.previewId);
        if (run?.previewId)
          void api<Preview>(`portfolio/changes/${run.previewId}/preview`)
            .then(setPreview)
            .catch((e) => setError(String(e)));
      })
      .catch((e) => {
        if (!gone) setError(String(e));
      });
    return () => {
      gone = true;
    };
  }, [active, session, context, storage]);
  useEffect(() => {
    if (!session || !draftEdited.current || running || busy) return;
    const timer = setTimeout(() => {
      void api<{ revision: number }>(`chat/sessions/${context}`, 'PATCH', {
        version: 1,
        draft,
        expectedRevision: revision.current,
      })
        .then((s) => {
          revision.current = s.revision;
        })
        .catch((e) => setError(String(e)));
    }, 700);
    return () => clearTimeout(timer);
  }, [draft, context, session, running, busy]);
  useEffect(() => {
    if (!latest || latest.status !== 'running') return;
    setLive(
      latest.events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta ?? '')
        .join(''),
    );
    setProgress('Processing your message…');
    const stream = new EventSource(
      `/api/v1/chat/runs/${latest.id}/events?after=${latest.events.length}`,
    );
    source.current = stream;
    stream.onmessage = (event) => {
      const item = JSON.parse(event.data) as {
        type: string;
        delta?: string;
        name?: string;
        message?: string;
      };
      if (item.type === 'text_delta') setLive((s) => s + (item.delta ?? ''));
      else if (item.type === 'tool_started')
        setProgress(
          item.name === 'portfolio_read_v1'
            ? 'Checking your recorded portfolio…'
            : 'Validating your proposed change…',
        );
      else if (item.type === 'error') setError(item.message ?? 'Run failed.');
    };
    stream.addEventListener('terminal', () => {
      stream.close();
      setLive('');
      setProgress('');
      void refresh().catch((e) => setError(String(e)));
    });
    stream.onerror = () =>
      setProgress('Connection interrupted. Reconnecting to the saved run…');
    return () => stream.close();
    // Run identity controls the stream; navigation does not cancel inference.
  }, [latest?.id, latest?.status]);
  async function send(message = draft, parentRunId?: string) {
    if (inFlight.current || running || disabled || !message.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const request =
        pending.current?.message === message.trim() &&
        pending.current.analysisMode === mode
          ? pending.current
          : {
              idempotencyKey: crypto.randomUUID(),
              message: message.trim(),
              analysisMode: mode,
            };
      pending.current = request;
      localStorage.setItem(storage + ':pending', JSON.stringify(request));
      await api<Run>(`chat/sessions/${context}/runs`, 'POST', {
        version: 1,
        ...request,
        ...(parentRunId ? { parentRunId } : {}),
      });
      pending.current = null;
      localStorage.removeItem(storage + ':pending');
      draftEdited.current = false;
      setDraft('');
      localStorage.removeItem(storage);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function saveDefault() {
    setError('');
    try {
      const settings = await api<{ revision: number }>('settings/analysis');
      await api('settings/analysis', 'PATCH', {
        version: 1,
        expectedRevision: settings.revision,
        defaultAnalysisMode: mode,
      });
      setProgress(`Default saved: ${mode}.`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function decide(confirm: boolean) {
    if (!preview || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await api(
        `portfolio/changes/${preview.id}/${confirm ? 'confirm' : 'reject'}`,
        'POST',
        confirm
          ? {
              version: 1,
              expectedRevision: preview.expectedRevision,
              confirmed: true,
            }
          : {},
      );
      setPreview(await api<Preview>(`portfolio/changes/${preview.id}/preview`));
      window.dispatchEvent(new Event('m2d:portfolio-changed'));
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      hidden={!active}
      className="agent-context"
      aria-label={`${label} chat`}
    >
      <div role="log" aria-label={`${label} conversation`}>
        <div className="agent-message">
          <strong>Agent</strong>
          <p>
            Ask about your recorded portfolio or describe a change. I will ask
            for missing details and show a preview before you confirm. Market
            research and live prices are not available yet.
          </p>
        </div>
        {session?.history
          .filter((i) => i.kind === 'text')
          .map((item) => (
            <div
              key={item.id}
              className={`agent-message ${item.role === 'user' ? 'from-user' : ''}`}
            >
              <strong>{item.role === 'user' ? 'You' : 'Agent'}</strong>
              <p>{item.text}</p>
            </div>
          ))}
        {live && (
          <div className="agent-message">
            <strong>Agent · in progress</strong>
            <p>{live}</p>
          </div>
        )}
      </div>
      {latest && (
        <details className="muted-label">
          <summary>
            {latest.analysisMode} · {latest.status} · {latest.provider} /{' '}
            {latest.model}
          </summary>
          <p>
            {latest.policyVersion} · {latest.completeness} ·{' '}
            {new Date(latest.startedAt).toLocaleString('en-CA', {
              timeZone: 'America/Vancouver',
            })}{' '}
            Vancouver
          </p>
          <p>
            Up to {latest.effectiveLimits.modelCalls} model attempts,{' '}
            {latest.effectiveLimits.toolCalls} tool calls,{' '}
            {latest.effectiveLimits.deadlineMs / 1000}s,{' '}
            {latest.effectiveLimits.maxOutputTokens} output tokens per attempt.
          </p>
          <p>
            Estimated cost:{' '}
            {latest.estimatedCost === null
              ? 'unknown'
              : `USD ${latest.estimatedCost}`}
            . Reserved: USD {latest.reservedCost}. Usage:{' '}
            {latest.usage
              ? `${latest.usage.inputTokens} input / ${latest.usage.outputTokens} output${latest.usage.complete ? '' : ' (incomplete)'}`
              : 'not reported'}
            .
          </p>
          {latest.limitReasons.length > 0 && (
            <p>{latest.limitReasons.join(', ')}</p>
          )}
        </details>
      )}
      {progress && <p role="status">{progress}</p>}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <section aria-label="Chat confirmation preview">
          <h3>Review before confirming</h3>
          <p>
            {preview.status} · revision {preview.expectedRevision} · effective{' '}
            {preview.effectiveAt}
          </p>
          <p>{preview.operation?.note}</p>
          {preview.warnings.map((w) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.key}>
                    <th>{c.key}</th>
                    <td>{c.before}</td>
                    <td>{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.realized.map((r, i) => (
            <p key={i}>
              Recorded close P&amp;L: {r.amount} {r.currency} · {r.quality}. Not
              tax reporting or historical performance.
            </p>
          ))}
          {preview.status === 'PENDING' && (
            <>
              <p>
                Expires {preview.expiresAt}. Confirmation updates your
                self-reported records; it does not place a trade.
              </p>
              <button
                disabled={busy || running}
                onClick={() => void decide(true)}
              >
                Confirm changes
              </button>
              <button
                disabled={busy || running}
                onClick={() => void decide(false)}
              >
                Dismiss preview
              </button>
            </>
          )}
        </section>
      )}
      <button
        type="button"
        disabled={busy || running}
        onClick={() => {
          void api<Session>(`chat/sessions/${context}/reset`, 'POST', {})
            .then((s) => {
              setSession(s);
              setPreview(null);
              setDraft('');
              revision.current = s.revision;
              localStorage.removeItem(storage);
              localStorage.removeItem(storage + ':pending');
              pending.current = null;
              draftEdited.current = false;
            })
            .catch((e) => setError(String(e)));
        }}
      >
        New conversation
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Work allowance
          <select
            aria-label={`${label} analysis mode`}
            value={mode}
            disabled={busy || running}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            <option value="quick">Quick</option>
            <option value="standard">Standard</option>
            <option value="extensive">Extensive</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void saveDefault()}
          disabled={busy || running}
        >
          Save as default
        </button>
        <label>
          {label} message
          <textarea
            value={draft}
            maxLength={4000}
            disabled={busy || running || disabled || !session}
            onChange={(e) => {
              draftEdited.current = true;
              setDraft(e.target.value);
              localStorage.setItem(storage, e.target.value);
            }}
            onKeyDown={submitAgentOnEnter}
            placeholder="Describe a reported change, or ask a question"
          />
        </label>
        <p className="muted-label">
          Enter to send · Shift+Enter for a new line. Modes change work limits;
          all changes require confirmation.
        </p>
        {running ? (
          <button
            type="button"
            onClick={() =>
              void api(`chat/runs/${latest.id}/cancel`, 'POST', {}).catch((e) =>
                setError(String(e)),
              )
            }
          >
            Cancel run
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy || disabled || !draft.trim() || !session}
          >
            Send
          </button>
        )}
        {latest && latest.status !== 'running' && (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() =>
              void send(
                'Continue the previous question using the selected work allowance. Ask for any missing facts.',
                latest.id,
              )
            }
          >
            Follow up in {mode}
          </button>
        )}
      </form>
    </section>
  );
}
