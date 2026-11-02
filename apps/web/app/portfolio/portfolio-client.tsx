'use client';
import { ChatMarkdown } from '../chat-markdown';
import {
  ResearchClient,
  type ResearchContext,
} from '../research/research-client';
import Link from 'next/link';
import { HoldingsTable, type HoldingSelection } from './holdings-table';
import { ResizablePanels } from '../resizable-panels';
import { AgentChat } from '../agent-chat';
import { ValuationPanel } from '../market/valuation';
import { agentContexts, submitAgentOnEnter } from '../agent-contexts';
import { usePathname } from 'next/navigation';
import {
  Suspense,
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type FormEvent,
} from 'react';
import type { State, Change, Realized, AccountDecision } from '@m2d/portfolio';
import type { ImportSource } from '@m2d/portfolio';
type Overview = {
  revision: number;
  effectiveAt: string | null;
  baselineId: string | null;
  state: State;
  warnings: string[];
};
type AccountQuestion = {
  sheet: string;
  accounts: { accountKey: string; displayName: string; institution: string }[];
};
type AiInfo = {
  reply?: string;
  intent?: string;
  accountQuestions?: AccountQuestion[];
  status: string;
  questions: string[];
  message?: string;
  provider: string;
  model: string;
  asOf?: string;
  runId?: string;
};
type ParseContext = {
  dialogue?:
    | {
        message: string;
        question: string;
        explain: boolean;
        history: { role: 'user' | 'assistant'; text: string }[];
      }
    | undefined;
  dialogueHistory?: { role: 'user' | 'assistant'; text: string }[];
  accountDecisions?: AccountDecision[];
  id: string;
  requestKey: string;
  clarification: string;
  lastClarification: string;
  ai: AiInfo | null;
};
type Exclusion = {
  sheet: string;
  row: number;
  reason: string;
  values: string[];
};
type Preview = {
  ai?: AiInfo;
  exclusions?: Exclusion[];
  importId?: string | null;
  sources?: ImportSource[];
  operation?: { note: string } | null;
  id: string;
  kind: string;
  status: string;
  confirmedRevision?: number | null;
  expectedRevision: number;
  effectiveAt: string;
  expiresAt: string;
  changes: Change[];
  warnings: string[];
  realized: Realized[];
};
type History = {
  accountKey: string | null;
  realized: Realized[];
  id: string;
  recordId: string;
  revision: number;
  kind: string;
  effectiveAt: string;
  availableAt: string;
  note: string;
  changes: Change[];
};
type RowError = { sheet: string; row: number; field: string; message: string };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/v1/${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : body instanceof FormData
        ? { method: 'POST', body }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
  );
  const result = (await response.json()) as {
    data: T;
    error?: {
      message: string;
      details?: { path: unknown[]; message: string }[];
    };
  };
  if (!response.ok)
    throw new Error(
      [
        result.error?.message ?? 'Request failed.',
        ...(Array.isArray(result.error?.details)
          ? result.error.details.map((d) => `${d.path.join('.')}: ${d.message}`)
          : []),
      ].join(' '),
    );
  return result.data;
}
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Vancouver',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'No confirmed records';
export function PortfolioSummary() {
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void api<Overview>('portfolio/overview')
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <section className="workspace-card">
      <div className="card-heading">
        <h2>Portfolio overview</h2>
        <Link className="text-link" href="/portfolio">
          Open portfolio →
        </Link>
      </div>
      <div className="form-body">
        {error ? (
          <p role="alert">{error}</p>
        ) : data ? (
          <>
            <div className="portfolio-stats">
              <div>
                <strong>
                  {data.state.accounts.filter((a) => a.active).length}
                </strong>
                <span>Active accounts</span>
              </div>
              <div>
                <strong>
                  {
                    data.state.positions.filter((p) => p.quantity !== '0')
                      .length
                  }
                </strong>
                <span>Open positions</span>
              </div>
              <div>
                <strong>{data.revision}</strong>
                <span>Confirmed revision</span>
              </div>
            </div>
            <p className="muted-label">
              Self-reported · Effective {date(data.effectiveAt)} ·
              America/Vancouver
            </p>
            {data.state.accounts.length === 0 && (
              <p>
                No portfolio records. Upload your Excel workbook to get started.
              </p>
            )}
          </>
        ) : (
          <p>Loading portfolio…</p>
        )}
      </div>
      <div className="card-note">
        Historical performance and tax cost basis are not established. Valuation
        coverage and FX sources appear separately below.
      </div>
    </section>
  );
}
function Changes({ changes }: { changes: Change[] }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Changes">
      <table>
        <thead>
          <tr>
            <th>Record</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.key}>
              <th>{c.key}</th>
              <td>{c.before}</td>
              <td>{c.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function PortfolioClient({ children }: { children?: ReactNode }) {
  const [researchContext, setResearchContext] =
    useState<ResearchContext | null>(null);
  const pathname = usePathname();
  const context =
    agentContexts.find((context) => context.path === pathname) ??
    agentContexts[7];
  const isPortfolio = context.path === '/portfolio';
  const [agentOpen, setAgentOpen] = useState(true);
  const [selectedHolding, setSelectedHolding] =
    useState<HoldingSelection | null>(null);
  const selectHolding = (holding: HoldingSelection | null) => {
    setSelectedHolding(holding);
    if (holding)
      localStorage.setItem('m2d:selected-holding', JSON.stringify(holding));
    else localStorage.removeItem('m2d:selected-holding');
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('m2d:selected-holding') ?? 'null',
      ) as HoldingSelection | null;
      if (
        saved &&
        typeof saved.accountKey === 'string' &&
        (saved.instrumentKey === undefined ||
          typeof saved.instrumentKey === 'string') &&
        typeof saved.label === 'string'
      )
        setSelectedHolding(saved);
    } catch {
      /* Ignore malformed browser preferences. */
    }
  }, []);
  const [conversation, setConversation] = useState<
    { role: 'Advisor' | 'You'; text: string }[]
  >([
    {
      role: 'Advisor',
      text: 'Upload your workbook. I will identify broker accounts, cash and holdings, ask about any unclear format, and show the changes for your confirmation.',
    },
  ]);
  useEffect(() => {
    setAgentOpen(localStorage.getItem('m2d.agent.closed') !== 'true');
  }, []);
  useEffect(() => {
    const open = () => {
      setAgentOpen(true);
      localStorage.setItem('m2d.agent.closed', 'false');
    };
    window.addEventListener('m2d:research-discuss', open);
    return () => window.removeEventListener('m2d:research-discuss', open);
  }, []);
  const toggleAgent = (open: boolean) => {
    setAgentOpen(open);
    localStorage.setItem('m2d.agent.closed', String(!open));
  };
  const say = (role: 'Advisor' | 'You', text: string) =>
    setConversation((messages) => [...messages, { role, text }]);
  const [review, setReview] = useState<ParseContext | null>(null);
  const [data, setData] = useState<Overview | null>(null),
    [history, setHistory] = useState<History[]>([]),
    [preview, setPreview] = useState<Preview | null>(null),
    [errors, setErrors] = useState<RowError[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [errorScope, setErrorScope] = useState('records'),
    [filter, setFilter] = useState(''),
    [seconds, setSeconds] = useState(0);
  useEffect(() => {
    window.dispatchEvent(new Event('m2d-market-updated'));
  }, [data?.revision]);
  const refresh = async () => {
    const [d, h] = await Promise.all([
      api<Overview>('portfolio/overview'),
      api<History[]>('portfolio/history'),
    ]);
    setData(d);
    setHistory(h);
  };
  useEffect(() => {
    const reload = () => {
      void refresh().catch((e: Error) => setError(e.message));
    };
    reload();
    window.addEventListener('m2d:portfolio-changed', reload);
    return () => window.removeEventListener('m2d:portfolio-changed', reload);
  }, []);
  useEffect(() => {
    const tick = () =>
      setSeconds(
        preview
          ? Math.max(
              0,
              Math.ceil((Date.parse(preview.expiresAt) - Date.now()) / 1000),
            )
          : 0,
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [preview]);
  const workInFlight = useRef(false);
  const work = async (scope: string, fn: () => Promise<void>) => {
    if (workInFlight.current) return;
    workInFlight.current = true;
    setErrorScope(scope);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      workInFlight.current = false;
      setBusy(false);
    }
  };
  const show = (p: Preview) => {
    if (window.location.pathname === '/portfolio') toggleAgent(true);
    say(
      'Advisor',
      p.status === 'CONFIRMED'
        ? 'This workbook was already confirmed.'
        : 'Please review these portfolio changes and confirm the full replacement. I will remember eligible format rules after confirmation.',
    );
    setPreview(p);
    setAck(false);
    setErrors([]);
    if (p.status === 'CONFIRMED')
      setMessage(
        'This upload was already confirmed. No duplicate changes were applied.',
      );
  };
  const upload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void work('upload', async () => {
      toggleAgent(true);
      setErrors([]);
      f.set('templateVersion', '1');
      f.set('expectedRevision', String(data!.revision));
      const result = await api<{
        id: string;
        inspection?: unknown;
        sources?: ImportSource[];
        preview: Preview | null;
        errors: RowError[];
      }>('portfolio/imports', f);
      setErrors(result.errors);
      setPreview(null);
      const usable =
        result.preview &&
        (result.preview.status === 'CONFIRMED' ||
          (result.preview.status === 'PENDING' &&
            result.preview.expectedRevision === data!.revision &&
            Date.parse(result.preview.expiresAt) > Date.now()));
      if (usable) {
        setReview(null);
        show({ ...result.preview!, sources: result.sources ?? [] });
      } else if (result.inspection) {
        const context: ParseContext = {
          id: result.id,
          requestKey: crypto.randomUUID(),
          clarification: '',
          lastClarification: '',
          ai: null,
        };
        setReview(context);
        await parseFile(context);
      } else setReview(null);
    });
  };
  const parseFile = async (context: ParseContext, retry = false) => {
    const result = await api<{
      preview: Preview | null;
      errors: RowError[];
      sources: ImportSource[];
      exclusions: Exclusion[];
      ai: AiInfo;
      acceptedClarification?: string;
    }>(`portfolio/imports/${context.id}/parse`, {
      version: 1,
      expectedRevision: data!.revision,
      idempotencyKey: context.requestKey,
      clarification: context.lastClarification,
      dialogue: context.dialogue,
      accountDecisions: context.accountDecisions ?? [],
      retry,
    });
    setErrors([]);
    if (result.ai.accountQuestions?.length)
      say(
        'Advisor',
        `Is "${result.ai.accountQuestions[0]!.sheet}" a new account or a rename? ${result.ai.accountQuestions.length} ${result.ai.accountQuestions.length === 1 ? 'tab remains' : 'tabs remain'} to identify. Your earlier choices are kept; nothing changes until you confirm the portfolio preview.`,
      );
    const reply = result.ai.reply || result.ai.questions[0];
    if (reply) say('Advisor', reply);
    if (result.preview) {
      show({
        ...result.preview,
        sources: result.sources,
        exclusions: result.exclusions,
        ai: result.ai,
      });
      setReview(null);
    } else
      setReview({
        ...context,
        lastClarification:
          result.acceptedClarification ??
          (result.ai.intent === 'explain' || result.ai.status === 'failed'
            ? context.lastClarification
            : context.dialogue
              ? [context.lastClarification, context.dialogue.message]
                  .filter(Boolean)
                  .join('\n')
              : context.clarification),
        clarification: '',
        dialogue: result.ai.status === 'failed' ? context.dialogue : undefined,
        dialogueHistory: [
          ...(context.dialogueHistory ?? []),
          ...(context.dialogue
            ? [{ role: 'user' as const, text: context.dialogue.message }]
            : []),
          ...(reply ? [{ role: 'assistant' as const, text: reply }] : []),
        ],
        ai: result.ai,
      });
  };
  const clarify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendReply();
  };
  const sendReply = (explain = false) => {
    if (!review) return;
    const text = explain
      ? 'Please explain this question.'
      : review.clarification.trim();
    if (text) say('You', text);
    const retry =
      review.ai?.status === 'failed' || review.ai?.status === 'needs_review';
    const context = {
      ...review,
      clarification: '',
      dialogue: text
        ? {
            message: text,
            question: review.ai?.questions[0] ?? '',
            explain,
            history: review.dialogueHistory ?? [],
          }
        : retry
          ? undefined
          : review.dialogue,
      requestKey:
        retry || Boolean(text) ? crypto.randomUUID() : review.requestKey,
    };
    setReview({
      ...context,
      clarification: '',
    });
    void work('upload', () => parseFile(context, retry));
  };
  const confirm = () =>
    void work('preview', async () => {
      const result = await api<{ revision: number; duplicate: boolean }>(
        `portfolio/changes/${preview!.id}/confirm`,
        {
          version: 1,
          expectedRevision: preview!.expectedRevision,
          confirmed: true,
          fullReplacementAcknowledged: ack,
        },
      );
      say(
        'Advisor',
        `Confirmed revision ${result.revision}. Your portfolio and eligible format memory are saved.`,
      );
      setPreview(null);
      setErrorScope('records');
      setMessage(
        `Confirmed revision ${result.revision}${result.duplicate ? ' (already applied; no duplicate)' : ''}.`,
      );
      await refresh();
    });
  const operationError = (scope: string) =>
    error && errorScope === scope ? (
      <p className="notice error" role="alert">
        {error}
      </p>
    ) : null;
  return (
    <ResizablePanels open={agentOpen}>
      <div>
        <div>{children}</div>
        <Suspense fallback={null}>
          <ResearchClient
            active={context.path === '/research'}
            onContext={setResearchContext}
          />
        </Suspense>
        {!data && isPortfolio && (
          <div>
            <p role="status">{error || 'Loading portfolio…'}</p>
            {error && (
              <button
                disabled={busy}
                onClick={() => void work('records', refresh)}
              >
                Reload portfolio
              </button>
            )}
          </div>
        )}
        {data && (
          <div className="portfolio-stack" hidden={!isPortfolio}>
            <div className="toolbar">
              <span className="muted-label">
                Revision {data.revision} · Effective {date(data.effectiveAt)} ·
                America/Vancouver
              </span>
              <button
                onClick={() => void work('records', refresh)}
                disabled={busy}
              >
                Reload records
              </button>
            </div>
            {operationError('records')}
            {message && (
              <p className="notice" role="status">
                {message}
              </p>
            )}
            <section className="workspace-card">
              <h2 className="sr-only">Accounts &amp; holdings</h2>
              <HoldingsTable
                state={data.state}
                account={filter}
                onAccountChange={setFilter}
                selected={selectedHolding}
                onSelect={(holding) => {
                  selectHolding(holding);
                  toggleAgent(true);
                }}
              />
              <div className="card-note">
                {data.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
                Market values are indicative; inspect price and FX coverage in
                the valuation section. No historical-return or tax-basis claim.
              </div>
            </section>
            <ValuationPanel key={data.revision} />
            <section className="workspace-card" aria-label="Replace from Excel">
              <div className="card-heading">
                <h2>Replace from Excel</h2>
              </div>
              <form className="form-body" onSubmit={upload}>
                {!review && operationError('upload')}
                <fieldset disabled={busy || !!preview}>
                  <p>
                    Upload your existing workbook, including multiple tabs and
                    different column layouts. We will identify positions and
                    cash, then let you review and correct the interpretation.
                    The replacement takes effect when you confirm.
                  </p>
                  <p className="notice">
                    Unlisted positions and cash will become zero; unlisted
                    accounts become inactive. Nothing changes until you confirm
                    the diff.
                  </p>
                  <label>
                    Excel workbook (.xlsx, up to 2 MiB)
                    <input type="file" name="file" accept=".xlsx" required />
                  </label>

                  <p className="muted-label">
                    USD by default; specify another currency when needed. Saved
                    formula values can be reviewed; formulas are never executed.
                    Missing cash or option terms must be resolved before
                    confirmation.
                  </p>
                  <p className="muted-label">
                    Workbook text is sent to the configured AI provider when
                    interpretation is needed. API usage is billed separately; no
                    dollar spending cap is configured. Offline fixture mode
                    makes no model calls.
                  </p>
                  <button type="submit">
                    {busy ? 'Processing…' : 'Preview workbook'}
                  </button>
                </fieldset>
              </form>
              {!review && errors.length > 0 && (
                <div className="form-body" role="alert">
                  <h3>Workbook needs corrections</h3>
                  <ul>
                    {errors.map((e, i) => (
                      <li key={i}>
                        {e.sheet} row {e.row || '—'} · {e.field}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            <section className="workspace-card" aria-label="Change log">
              <div className="card-heading">
                <h2>Change log</h2>
                {operationError('history')}
                <span className="badge">History is preserved</span>
              </div>
              <div className="form-body">
                {history.length === 0 ? (
                  <p>No confirmed changes.</p>
                ) : (
                  history
                    .filter(
                      (h) =>
                        !filter ||
                        h.accountKey === filter ||
                        h.changes.some((c) => c.key.split(':')[1] === filter),
                    )
                    .map((h) => (
                      <details key={h.id}>
                        <summary>
                          Revision {h.revision} · {h.note} ·{' '}
                          {date(h.effectiveAt)}
                        </summary>
                        <p className="muted-label">
                          Recorded {date(h.availableAt)} · {h.kind} · ID{' '}
                          {h.recordId}
                        </p>
                        <Changes changes={h.changes} />
                        {h.realized.map((r, i) => (
                          <p key={i}>
                            Recorded close P&amp;L: {r.amount} {r.currency} ·{' '}
                            {r.quality}. Not historical performance or tax
                            reporting.
                          </p>
                        ))}
                        {h.kind === 'BASELINE' && (
                          <button
                            disabled={busy || !!preview}
                            onClick={() =>
                              void work('history', async () =>
                                show(
                                  await api<Preview>(
                                    `portfolio/baselines/${h.recordId}/restore-preview`,
                                    {
                                      version: 1,
                                      expectedRevision: data.revision,
                                      idempotencyKey: crypto.randomUUID(),
                                      effectiveAt: new Date().toISOString(),
                                    },
                                  ),
                                ),
                              )
                            }
                          >
                            Preview restore as a new baseline effective now
                          </button>
                        )}
                      </details>
                    ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>
      <aside className="agent-panel" aria-label="Advisor" hidden={!agentOpen}>
        <div className="agent-heading">
          <h2>Advisor · {context.label}</h2>
          <button
            type="button"
            aria-label="Close Advisor"
            onClick={() => toggleAgent(false)}
          >
            Close
          </button>
        </div>
        <div className="agent-content">
          {!isPortfolio && (review || preview || busy) && (
            <p className="notice">
              You have unfinished Portfolio work.{' '}
              <Link href="/portfolio">Return to Portfolio</Link> to continue.
            </p>
          )}
          {agentContexts
            .filter((item) => item.path !== '/portfolio')
            .map((item) => (
              <AgentChat
                key={item.path}
                context={
                  item.path === '/'
                    ? 'dashboard'
                    : item.path === '/chat'
                      ? 'general'
                      : item.path.slice(1)
                }
                researchContext={
                  item.path === '/research' ? researchContext : null
                }
                label={item.label}
                active={item.path === context.path}
              />
            ))}
          <AgentChat
            selectedHolding={selectedHolding}
            onClearHolding={() => selectHolding(null)}
            context="portfolio"
            label="Portfolio"
            active={isPortfolio && !review && !preview && !busy}
            disabled={busy}
          />
          <div
            className="agent-context"
            hidden={!isPortfolio || (!review && !preview && !busy)}
          >
            <div
              className="agent-transcript"
              role="log"
              aria-label="Conversation with Advisor"
            >
              {conversation.map((m, i) => (
                <div
                  className={`agent-message ${m.role === 'You' ? 'from-user' : ''}`}
                  key={i}
                >
                  <strong>{m.role === 'You' ? 'You' : 'Advisor'}</strong>
                  <ChatMarkdown text={m.text} />
                </div>
              ))}
            </div>
            {review && operationError('upload')}
            {review && (
              <div
                className="form-body"
                role="region"
                aria-label="Workbook clarification"
              >
                <h3>{busy ? 'Processing your workbook…' : 'Your reply'}</h3>
                {review.ai?.message && review.ai.status === 'failed' && (
                  <p
                    className="notice"
                    role={review.ai.status === 'failed' ? 'alert' : 'status'}
                  >
                    {review.ai.message}
                  </p>
                )}
                {review.ai?.accountQuestions?.slice(0, 1).map((question) => (
                  <AccountChoice
                    key={question.sheet}
                    question={question}
                    busy={busy}
                    choose={(decision) => {
                      if (workInFlight.current) return;
                      const context = {
                        ...review,
                        clarification: review.lastClarification,
                        accountDecisions: [
                          ...(review.accountDecisions ?? []).filter(
                            (d) => d.sheet !== decision.sheet,
                          ),
                          decision,
                        ],
                        requestKey: crypto.randomUUID(),
                      };
                      say(
                        'You',
                        decision.kind === 'new'
                          ? `Create a new account for "${decision.sheet}".`
                          : `"${decision.sheet}" renames account ${decision.accountKey}.`,
                      );
                      setReview(context);
                      void work('upload', () => parseFile(context));
                    }}
                  />
                ))}
                {!review.ai?.accountQuestions?.length && (
                  <form onSubmit={clarify}>
                    {review.ai?.intent === 'explain' &&
                      review.ai.questions[0] && (
                        <div className="notice" aria-label="Pending question">
                          <strong>Still to answer</strong>
                          <p>{review.ai.questions[0]}</p>
                        </div>
                      )}
                    <p id="agent-reply-help" className="muted-label">
                      Answer this question, or ask Advisor what it means. Asking
                      for help keeps the question open and does not supply a
                      workbook value. Enter to send · Shift+Enter for a new
                      line.
                    </p>
                    <fieldset disabled={busy}>
                      <label>
                        Message Advisor
                        <textarea
                          maxLength={4000}
                          onKeyDown={submitAgentOnEnter}
                          value={review.clarification}
                          onChange={(e) =>
                            setReview({
                              ...review,
                              clarification: e.target.value,
                            })
                          }
                          placeholder="Type an answer or ask a follow-up question"
                          aria-describedby="agent-reply-help"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={
                          review.ai?.status === 'needs_clarification' &&
                          !error &&
                          !review.clarification.trim()
                        }
                      >
                        {review.ai?.status === 'needs_review' &&
                        !review.clarification.trim()
                          ? 'Retry interpretation'
                          : review.ai?.status === 'failed'
                            ? 'Retry AI parsing'
                            : 'Send to Advisor'}
                      </button>
                      {review.ai?.questions[0] && (
                        <button
                          type="button"
                          disabled={!!review.clarification.trim()}
                          onClick={() => sendReply(true)}
                        >
                          Explain this question
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setReview(null);
                          setErrors([]);
                          setError('');
                        }}
                      >
                        Cancel import
                      </button>
                    </fieldset>
                  </form>
                )}
              </div>
            )}

            {preview && data && (
              <section
                className="workspace-card preview"
                aria-label="Confirmation preview"
              >
                <div className="card-heading">
                  <h2>Review before confirming</h2>
                  {operationError('preview')}
                  <span className="badge">
                    {preview.status}
                    {preview.status === 'PENDING'
                      ? ' · ' + seconds + 's remaining'
                      : ''}
                  </span>
                </div>
                <div className="form-body">
                  <p>
                    Expected revision {preview.expectedRevision} · Effective{' '}
                    {preview.importId && preview.status === 'PENDING'
                      ? 'On confirmation'
                      : date(preview.effectiveAt)}
                  </p>
                  {preview.operation && <p>{preview.operation.note}</p>}
                  {preview.warnings.map((w) => (
                    <p key={w} className="notice">
                      {w}
                    </p>
                  ))}
                  {preview.ai && (
                    <p className="muted-label">
                      {preview.ai.provider === 'fixture'
                        ? 'Offline fixture interpretation'
                        : `AI interpretation · ${preview.ai.provider} / ${preview.ai.model}`}{' '}
                      · {date(preview.ai.asOf ?? null)}
                    </p>
                  )}
                  {!!preview.exclusions?.length && (
                    <details>
                      <summary>
                        Review {preview.exclusions.length} excluded source rows
                      </summary>
                      <ul>
                        {preview.exclusions.map((e, i) => (
                          <li key={i}>
                            {e.sheet} row {e.row}: {e.values.join(' · ')} —{' '}
                            {e.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <Changes changes={preview.changes} />
                  {!!preview.sources?.length && (
                    <details>
                      <summary>Interpreted source rows</summary>
                      <div className="table-scroll" tabIndex={0}>
                        <table>
                          <thead>
                            <tr>
                              <th>Source</th>
                              <th>Account</th>
                              <th>Record</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.sources.map((s, i) => (
                              <tr key={i}>
                                <td>
                                  {s.sheet}
                                  {s.row ? ` · row ${s.row}` : ''}
                                </td>
                                <td>{s.accountKey}</td>
                                <td>
                                  {s.kind} · {s.identity}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                  {preview.realized.map((r, i) => (
                    <p key={i}>
                      Recorded close P&amp;L: {r.amount} {r.currency} ·{' '}
                      {r.quality}. This is not historical performance or tax
                      reporting.
                    </p>
                  ))}
                  {preview.status === 'CONFIRMED' && (
                    <div className="confirmation-guidance" role="status">
                      <strong>This workbook was already applied.</strong>
                      <p>
                        Uploading the same file does not apply it twice. To
                        replace your current portfolio with this workbook again,
                        create a new preview below. Changes recorded since that
                        workbook may be replaced.
                      </p>
                      {history.find(
                        (h) =>
                          h.kind === 'BASELINE' &&
                          h.revision === preview.confirmedRevision,
                      ) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void work('preview', async () => {
                              const baseline = history.find(
                                (h) =>
                                  h.kind === 'BASELINE' &&
                                  h.revision === preview.confirmedRevision,
                              )!;
                              show(
                                await api<Preview>(
                                  `portfolio/baselines/${baseline.recordId}/restore-preview`,
                                  {
                                    version: 1,
                                    expectedRevision: data.revision,
                                    idempotencyKey: crypto.randomUUID(),
                                    effectiveAt: new Date().toISOString(),
                                  },
                                ),
                              );
                            })
                          }
                        >
                          Review this workbook again
                        </button>
                      )}
                    </div>
                  )}
                  {preview.status === 'PENDING' &&
                    (seconds <= 0 || !Number.isFinite(seconds)) && (
                      <p className="notice" role="status">
                        This preview has expired. Dismiss it and upload the
                        workbook again to review a fresh preview.
                      </p>
                    )}
                  {preview.status === 'PENDING' &&
                    seconds > 0 &&
                    preview.kind === 'BASELINE' &&
                    !ack && (
                      <p
                        className="confirmation-guidance"
                        id="workbook-confirm-help"
                      >
                        To enable confirmation, check the full-replacement
                        acknowledgement below.
                      </p>
                    )}{' '}
                  {preview.kind === 'BASELINE' &&
                    preview.status === 'PENDING' && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={ack}
                          onChange={(e) => setAck(e.target.checked)}
                        />
                        I confirm this is a full replacement: unlisted holdings
                        and cash become zero and unlisted accounts become
                        inactive. History is preserved.
                      </label>
                    )}
                  <div className="toolbar">
                    <button
                      className="primary"
                      onClick={confirm}
                      disabled={
                        busy ||
                        seconds <= 0 ||
                        !Number.isFinite(seconds) ||
                        preview.status !== 'PENDING' ||
                        (preview.kind === 'BASELINE' && !ack)
                      }
                    >
                      {preview.status === 'CONFIRMED'
                        ? 'Already applied'
                        : 'Confirm changes'}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void work('preview', async () => {
                          if (preview.status === 'PENDING')
                            await api(
                              `portfolio/changes/${preview.id}/reject`,
                              {},
                            );
                          setPreview(null);
                        })
                      }
                    >
                      Dismiss preview
                    </button>
                  </div>
                </div>
              </section>
            )}

            {!review && !preview && (
              <p className="muted-label">
                Upload a workbook to begin. Asset class, equity symbol and
                quantity are required; description and unit cost are optional.
              </p>
            )}
          </div>
        </div>
      </aside>
      {!agentOpen && (
        <button
          className="agent-reopen primary"
          onClick={() => toggleAgent(true)}
        >
          Open Advisor
        </button>
      )}
    </ResizablePanels>
  );
}

function AccountChoice({
  question,
  busy,
  choose,
}: {
  question: AccountQuestion;
  busy: boolean;
  choose: (decision: AccountDecision) => void;
}) {
  const [target, setTarget] = useState('');
  return (
    <fieldset disabled={busy} className="account-question">
      <legend>Tab: {question.sheet}</legend>
      <p>Is this a new account, or has an existing account been renamed?</p>
      <button
        type="button"
        onClick={() => choose({ sheet: question.sheet, kind: 'new' })}
      >
        Create new account: {question.sheet}
      </button>
      <label>
        Existing account to rename
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose an existing account</option>
          {question.accounts.map((a) => (
            <option key={a.accountKey} value={a.accountKey}>
              {a.displayName} · {a.institution || 'Broker not recorded'} ·{' '}
              {a.accountKey}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!target}
        onClick={() =>
          choose({ sheet: question.sheet, kind: 'rename', accountKey: target })
        }
      >
        Rename selected account to {question.sheet}
      </button>
      <p className="muted-label">
        Rename keeps the same account ID and history. This choice takes effect
        only after portfolio confirmation.
      </p>
    </fieldset>
  );
}
