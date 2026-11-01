'use client';
import { ChatMarkdown } from './chat-markdown';
import type { ResearchContext } from './research/research-client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Change } from '@m2d/portfolio';
import type { HoldingSelection } from './portfolio/holdings-table';
import { submitAgentOnEnter } from './agent-contexts';
type Language = 'en' | 'zh-CN';
type Mode = 'quick' | 'standard' | 'extensive';
type Run = {
  id: string;
  status: string;
  provider: string;
  model: string;
  analysisMode: Mode;
  outputLanguage?: Language | null;
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
  dailyUsage?: {
    budgetedCost: string;
    replies: number;
    unpricedReplies: number;
  };
  dailyBudget?: string | null;
  revision: number;
  draft: string;
  history: {
    id: string;
    kind: string;
    role?: string;
    text?: string;
    holdingContext?: { accountKey: string; instrumentKey?: string };
  }[];
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
  operation: { note: string; transactionDate?: string };
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
  selectedHolding = null,
  onClearHolding,
  researchContext = null,
}: {
  context: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  selectedHolding?: HoldingSelection | null;
  onClearHolding?: () => void;
  researchContext?: ResearchContext | null;
}) {
  useEffect(() => {
    if (context !== 'research') return;
    const receive = (e: Event) => {
      const message = (e as CustomEvent<unknown>).detail;
      if (typeof message === 'string') {
        setDraft(message);
        draftEdited.current = true;
        localStorage.setItem('m2d:chat-draft:research', message);
      }
    };
    window.addEventListener('m2d:research-discuss', receive);
    return () => window.removeEventListener('m2d:research-discuss', receive);
  }, [context]);
  const [session, setSession] = useState<Session | null>(null),
    [draft, setDraft] = useState(''),
    [mode, setMode] = useState<Mode>('standard'),
    [language, setLanguage] = useState<Language>('en'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [savingMode, setSavingMode] = useState(false),
    [progress, setProgress] = useState(''),
    [live, setLive] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledgedPreviewId, setAcknowledgedPreviewId] = useState<
    string | null
  >(null);
  const readingPane = useRef<HTMLDivElement>(null),
    followLatest = useRef(true),
    forceScroll = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  useLayoutEffect(() => {
    if (!active || !readingPane.current) return;
    if (followLatest.current || forceScroll.current) {
      readingPane.current.scrollTop = readingPane.current.scrollHeight;
      followLatest.current = true;
      forceScroll.current = false;
    }
  }, [active, session, live, preview, error, progress, selectedHolding]);
  const revision = useRef(0),
    inFlight = useRef(false),
    draftEdited = useRef(false),
    pending = useRef<{
      idempotencyKey: string;
      message: string;
      analysisMode: Mode;
      outputLanguage?: Language;
      researchContext?: ResearchContext;
      holdingContext?: { accountKey: string; instrumentKey?: string };
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
      api<{ effectiveDefault: Mode; outputLanguage: Language }>(
        'settings/analysis',
      ),
    ])
      .then(([s, settings]) => {
        if (gone) return;
        setSession(s);
        revision.current = s.revision;
        setMode(settings.effectiveDefault);
        setLanguage(settings.outputLanguage ?? 'en');
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
    followLatest.current = true;
    forceScroll.current = true;
    setShowLatest(false);
    setProgress('Sending your message…');
    setBusy(true);
    setError('');
    try {
      const request =
        pending.current?.message === message.trim() &&
        pending.current.analysisMode === mode &&
        (pending.current.outputLanguage ?? 'en') === language &&
        JSON.stringify(pending.current.researchContext) ===
          JSON.stringify(researchContext ?? undefined) &&
        JSON.stringify(pending.current.holdingContext) ===
          JSON.stringify(
            selectedHolding
              ? {
                  accountKey: selectedHolding.accountKey,
                  ...(selectedHolding.instrumentKey
                    ? { instrumentKey: selectedHolding.instrumentKey }
                    : {}),
                }
              : undefined,
          )
          ? pending.current
          : {
              idempotencyKey: crypto.randomUUID(),
              message: message.trim(),
              ...(researchContext ? { researchContext } : {}),
              analysisMode: mode,
              outputLanguage: language,
              ...(selectedHolding
                ? {
                    holdingContext: {
                      accountKey: selectedHolding.accountKey,
                      ...(selectedHolding.instrumentKey
                        ? { instrumentKey: selectedHolding.instrumentKey }
                        : {}),
                    },
                  }
                : {}),
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
      forceScroll.current = true;
      followLatest.current = true;
      setProgress('');
    } catch (e) {
      setProgress('');
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function saveDefault(next: Mode, outputLanguage: Language = language) {
    setMode(next);
    setLanguage(outputLanguage);
    setSavingMode(true);
    setError('');
    try {
      const settings = await api<{ revision: number }>('settings/analysis');
      await api('settings/analysis', 'PATCH', {
        version: 1,
        expectedRevision: settings.revision,
        defaultAnalysisMode: next,
        outputLanguage,
      });
      // Preferences apply to future sends; the running reply keeps its snapshot.
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingMode(false);
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
              tradeNotAlreadyIncluded: acknowledgedPreviewId === preview.id,
            }
          : {},
      );
      setPreview(await api<Preview>(`portfolio/changes/${preview.id}/preview`));
      if (confirm) onClearHolding?.();
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
      <div
        className="agent-reading-pane"
        ref={readingPane}
        onScroll={(e) => {
          const pane = e.currentTarget;
          if (forceScroll.current) return;
          followLatest.current =
            pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
          setShowLatest(!followLatest.current);
        }}
      >
        <div role="log" aria-label={`${label} conversation`}>
          {researchContext && (
            <p className="message-holding-context">
              Research · {researchContext.symbol}
              {researchContext.at
                ? ` · available by ${researchContext.at}`
                : ''}
            </p>
          )}
          <div className="agent-message">
            <strong>Advisor</strong>
            <p>
              Ask a question or describe a portfolio change. I’ll show any
              changes for your confirmation.
            </p>
          </div>
          {session?.history
            .filter((i) => i.kind === 'text')
            .map((item) => (
              <div
                key={item.id}
                className={`agent-message ${item.role === 'user' ? 'from-user' : ''}`}
              >
                <strong>{item.role === 'user' ? 'You' : 'Advisor'}</strong>
                {item.holdingContext && (
                  <small className="message-holding-context">
                    {item.holdingContext.instrumentKey
                      ?.split('|')
                      .filter((_, i) => [1, 4, 5, 6].includes(i))
                      .filter(Boolean)
                      .join(' · ')}{' '}
                    · {item.holdingContext.accountKey}
                  </small>
                )}
                <ChatMarkdown text={item.text ?? ''} />
              </div>
            ))}
          {live && (
            <div className="agent-message">
              <strong>Advisor · in progress</strong>
              <ChatMarkdown text={live} />
            </div>
          )}
        </div>
        {latest && (
          <details className="muted-label">
            <summary>
              Usage for this reply · {latest.analysisMode} · {latest.status} ·{' '}
              {latest.provider} / {latest.model}
            </summary>
            <p>
              {latest.policyVersion} · {latest.completeness} ·{' '}
              {new Date(latest.startedAt).toLocaleString('en-CA', {
                timeZone: 'America/Vancouver',
              })}{' '}
              Vancouver ·{' '}
              {latest.outputLanguage === 'zh-CN'
                ? '简体中文'
                : latest.outputLanguage === 'en'
                  ? 'English'
                  : 'Language not recorded'}
            </p>
            <p>
              Up to {latest.effectiveLimits.modelCalls} model attempts,{' '}
              {latest.effectiveLimits.toolCalls} tool calls,{' '}
              {latest.effectiveLimits.deadlineMs / 1000}s,{' '}
              {latest.effectiveLimits.maxOutputTokens} output tokens per
              attempt.
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
        {session?.dailyUsage && (
          <details className="agent-run">
            <summary>Daily usage (UTC)</summary>
            <p>
              {session.dailyUsage.replies} replies across conversations · USD{' '}
              {session.dailyUsage.budgetedCost} budgeted
              {session.dailyBudget ? ' / USD ' + session.dailyBudget : ''}.
            </p>
            <p>
              Includes recorded reply and research embedding costs plus pending
              reservations.
            </p>
            {session.dailyUsage.unpricedReplies > 0 && (
              <p>
                Some reply costs are unavailable; the dollar total is
                incomplete.
              </p>
            )}
          </details>
        )}
        {progress && <p role="status">{progress}</p>}
        {(error ||
          latest?.events.findLast((e) => e.type === 'error')?.message) && (
          <p className="notice" role="alert">
            {error ||
              latest?.events.findLast((e) => e.type === 'error')?.message}
          </p>
        )}
        {preview && (
          <section aria-label="Chat confirmation preview">
            <h3>Review before confirming</h3>
            <p>
              {preview.status} · revision {preview.expectedRevision} · Recorded{' '}
              {preview.status === 'PENDING'
                ? 'on confirmation'
                : preview.effectiveAt}
            </p>
            {preview.operation?.transactionDate && (
              <p>
                <strong>Trade date:</strong> {preview.operation.transactionDate}{' '}
                · reported separately from the recording time.
              </p>
            )}
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
                Recorded close P&amp;L: {r.amount} {r.currency} · {r.quality}.
                Not tax reporting or historical performance.
              </p>
            ))}
            {preview.status === 'PENDING' && (
              <>
                {preview.operation?.transactionDate && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={acknowledgedPreviewId === preview.id}
                      onChange={(e) =>
                        setAcknowledgedPreviewId(
                          e.target.checked ? preview.id : null,
                        )
                      }
                    />
                    I confirm this trade is not already included in my current
                    holdings or cash. Apply it once to my current records.
                  </label>
                )}
                <p>
                  Expires {preview.expiresAt}. Confirmation updates your
                  self-reported records; it does not place a trade.
                </p>
                <button
                  disabled={
                    busy ||
                    running ||
                    (!!preview.operation?.transactionDate &&
                      acknowledgedPreviewId !== preview.id)
                  }
                  onClick={() => void decide(true)}
                >
                  Confirm changes
                </button>
                <button
                  disabled={busy || running || savingMode}
                  onClick={() => void decide(false)}
                >
                  Dismiss preview
                </button>
              </>
            )}
          </section>
        )}
      </div>
      {showLatest && (
        <button
          type="button"
          className="latest-message"
          onClick={() => {
            followLatest.current = true;
            setShowLatest(false);
            if (readingPane.current)
              readingPane.current.scrollTop = readingPane.current.scrollHeight;
          }}
        >
          Latest message ↓
        </button>
      )}
      <div className="agent-conversation-actions">
        <button
          type="button"
          disabled={busy || running || savingMode || !session}
          title="Reset this conversation and its unsent draft"
          onClick={() => {
            if (inFlight.current || running || !session) return;
            inFlight.current = true;
            setBusy(true);
            void api<Session>(`chat/sessions/${context}/reset`, 'POST', {})
              .then((s) => {
                followLatest.current = true;
                setShowLatest(false);
                setProgress('');
                setError('');
                setLive('');
                if (readingPane.current) readingPane.current.scrollTop = 0;
                setSession(s);
                setPreview(null);
                setDraft('');
                revision.current = s.revision;
                localStorage.removeItem(storage);
                localStorage.removeItem(storage + ':pending');
                pending.current = null;
                draftEdited.current = false;
              })
              .catch((e) => setError(String(e)))
              .finally(() => {
                inFlight.current = false;
                setBusy(false);
              });
          }}
        >
          Reset conversation
        </button>
        <div className="agent-mode-settings">
          <label className="agent-mode-field">
            Analysis mode · next send
            <select
              aria-label={`${label} analysis mode`}
              value={mode}
              disabled={savingMode || !session}
              onChange={(e) => void saveDefault(e.target.value as Mode)}
            >
              <option value="quick">Quick</option>
              <option value="standard">Standard</option>
              <option value="extensive">Extensive</option>
            </select>
          </label>
          <label className="agent-mode-field">
            Reply language
            <select
              aria-label={`${label} reply language`}
              value={language}
              disabled={savingMode || !session}
              onChange={(e) =>
                void saveDefault(mode, e.target.value as Language)
              }
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <small className="agent-next-send-note">
            Settings apply to the next send. Conversation context is kept.
          </small>
        </div>
      </div>
      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {selectedHolding && (
          <div className="holding-context-chip">
            <span>
              <strong>
                {selectedHolding.instrumentKey
                  ? 'Selected holding'
                  : 'Selected account'}
              </strong>
              {selectedHolding.label}
            </span>
            <button
              type="button"
              aria-label={
                selectedHolding.instrumentKey
                  ? 'Clear selected holding'
                  : 'Clear selected account'
              }
              onClick={onClearHolding}
            >
              ×
            </button>
          </div>
        )}
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
            placeholder={
              selectedHolding
                ? 'e.g. Sold 3 shares at $200, no fees'
                : 'Message Advisor…'
            }
          />
        </label>
        <p className="muted-label">
          Enter to send · Shift+Enter for a new line
        </p>
        <div className="agent-send-actions">
          {running ? (
            <button
              type="button"
              onClick={() =>
                void api(`chat/runs/${latest.id}/cancel`, 'POST', {}).catch(
                  (e) => setError(String(e)),
                )
              }
            >
              Cancel run
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
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
        </div>
      </form>
    </section>
  );
}
