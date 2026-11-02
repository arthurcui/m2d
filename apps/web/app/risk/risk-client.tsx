'use client';
import { Decimal } from 'decimal.js';
import { useEffect, useState } from 'react';
import { instrumentKey, type State, type Instrument } from '@m2d/portfolio';
import type { HoldingSelection } from '../portfolio/holdings-table';
import type {
  riskSummary,
  evaluateStrategy,
  evaluateStockTrade,
  validatePlan,
  StrategyInput,
  PlanInput,
} from '@m2d/risk';
type Summary = ReturnType<typeof riskSummary> & {
  portfolioRevision: number;
  baseExposure?: {
    currency: string;
    knownNet: string;
    knownGross: string;
    complete: boolean;
  } | null;
};
type Assessment = ReturnType<typeof validatePlan>;
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    '/api/v1/' + path,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error?.message ?? 'Request failed');
  return value.data as T;
}
const equity = (symbol: string): Instrument => ({
  assetType: 'STOCK',
  symbol: symbol.toUpperCase(),
  exchange: 'UNKNOWN',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
});
export function RiskClient({
  active,
  portfolioSelection,
  onContext,
}: {
  active: boolean;
  portfolioSelection: HoldingSelection | null;
  onContext: (value: HoldingSelection | null) => void;
}) {
  const [tab, setTab] = useState('Portfolio Risk'),
    [summary, setSummary] = useState<Summary | null>(null),
    [state, setState] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [newAsset, setNewAsset] = useState<'STOCK' | 'ETF'>('STOCK'),
    [newCurrency, setNewCurrency] = useState('USD');
  const [account, setAccount] = useState(''),
    [symbol, setSymbol] = useState(''),
    [selection, setSelection] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [price, setPrice] = useState(''),
    [fees, setFees] = useState('0'),
    [slippage, setSlippage] = useState(''),
    [action, setAction] = useState<'BUY' | 'SELL'>('BUY'),
    [stop, setStop] = useState(''),
    [target, setTarget] = useState(''),
    [budget, setBudget] = useState('');
  const [strategy, setStrategy] = useState<StrategyInput['strategy']>('STOCK'),
    [right, setRight] = useState<'CALL' | 'PUT'>('CALL'),
    [expiry, setExpiry] = useState(''),
    [strike, setStrike] = useState(''),
    [secondStrike, setSecondStrike] = useState(''),
    [secondPrice, setSecondPrice] = useState(''),
    [sharePrice, setSharePrice] = useState('');
  const [entryCondition, setEntryCondition] = useState(''),
    [invalidation, setInvalidation] = useState(''),
    [mainRisk, setMainRisk] = useState(''),
    [exit, setExit] = useState(''),
    [reviewed, setReviewed] = useState(false);
  const [stockResult, setStockResult] = useState<ReturnType<
      typeof evaluateStockTrade
    > | null>(null),
    [result, setResult] = useState<ReturnType<typeof evaluateStrategy> | null>(
      null,
    ),
    [preview, setPreview] = useState<{
      assessment: Assessment;
      input: PlanInput;
    } | null>(null),
    [plans, setPlans] = useState<
      Array<{ id: string; created_at: string; assessment: Assessment }>
    >([]);
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to finish');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [s, p, list] = await Promise.all([
      request<Summary>('risk/summary'),
      request<{ state: State }>('portfolio/overview'),
      request<typeof plans>('risk/plans'),
    ]);
    setSummary(s);
    setState(p.state);
    setPlans(list);
    setAccount((old) => old || p.state.accounts[0]?.accountKey || '');
  }
  useEffect(() => {
    if (active && !summary) void work(refresh);
  }, [active]); // Drafts remain mounted across navigation.
  const selected =
    selection !== '' ? state?.positions[Number(selection)] : undefined;
  useEffect(() => {
    onContext(
      account
        ? {
            accountKey: account,
            ...(selected
              ? { instrumentKey: instrumentKey(selected.instrument) }
              : {}),
            label: selected
              ? `${account} · ${selected.instrument.symbol}`
              : account,
          }
        : null,
    );
  }, [account, selected, onContext]);
  function chooseHolding(value: string) {
    setSelection(value);
    const p = value === '' ? undefined : state?.positions[Number(value)];
    if (p) {
      setAccount(p.accountKey);
      setSymbol(p.instrument.underlying ?? p.instrument.symbol);
      setNewCurrency(p.instrument.currency);
      if (p.instrument.assetType === 'OPTION') {
        setStrategy(
          p.instrument.optionRight === 'CALL' ? 'LONG_CALL' : 'LONG_PUT',
        );
        setExpiry(p.instrument.expiry ?? '');
        setStrike(p.instrument.strike ?? '');
      } else {
        setStrategy('STOCK');
        setNewAsset(p.instrument.assetType);
      }
    }
    setPreview(null);
    setResult(null);
    setStockResult(null);
  }
  function instrument() {
    return selected?.instrument.assetType !== 'OPTION'
      ? (selected?.instrument ?? {
          ...equity(symbol),
          assetType: newAsset,
          currency: newCurrency,
        })
      : { ...equity(symbol), assetType: newAsset, currency: newCurrency };
  }
  function analysis(): StrategyInput {
    const base = instrument();
    let legs: StrategyInput['legs'];
    const option = (k: string, r: 'CALL' | 'PUT'): Instrument => ({
      ...base,
      assetType: 'OPTION',
      symbol: base.symbol,
      underlying: base.symbol,
      optionRight: r,
      expiry,
      strike: k,
      multiplier: '100',
      deliverable: 'STANDARD',
    });
    if (strategy === 'STOCK')
      legs = [{ instrument: base, quantity, entryPrice: price }];
    else if (strategy === 'COVERED_CALL')
      legs = [
        {
          instrument: base,
          quantity: new Decimal(quantity).mul(100).toFixed(),
          entryPrice: sharePrice,
        },
        {
          instrument: option(strike, 'CALL'),
          quantity: '-' + quantity.replace(/^-/, ''),
          entryPrice: price,
        },
      ];
    else if (strategy === 'VERTICAL')
      legs = [
        { instrument: option(strike, right), quantity, entryPrice: price },
        {
          instrument: option(secondStrike, right),
          quantity: quantity.startsWith('-')
            ? quantity.slice(1)
            : '-' + quantity,
          entryPrice: secondPrice,
        },
      ];
    else
      legs = [
        {
          instrument: option(strike, strategy === 'LONG_CALL' ? 'CALL' : 'PUT'),
          quantity:
            strategy === 'CASH_SECURED_PUT'
              ? '-' + quantity.replace(/^-/, '')
              : quantity,
          entryPrice: price,
        },
      ];
    return {
      version: 1,
      strategy,
      accountKey: account,
      legs,
      fees,
      slippage: slippage || null,
      scenarioPrices: [],
    };
  }
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    type = 'text',
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setPreview(null);
        }}
      />
    </label>
  );
  return (
    <section
      hidden={!active}
      className="research-workspace risk-workspace"
      onChangeCapture={() => {
        setPreview(null);
        setStockResult(null);
        setResult(null);
      }}
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Portfolio decisions</p>
          <h1>Trade Planner</h1>
          <p>
            Review exposure, compare hypothetical trades, and save a plan. No
            orders or portfolio changes.
          </p>
        </div>
        <button disabled={busy} onClick={() => void work(refresh)}>
          Refresh risk
        </button>
        <button
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('m2d:risk-discuss', {
                detail:
                  tab === 'Plan a Trade'
                    ? `Help plan a hypothetical ${strategy} trade for ${symbol || 'a ticker to choose'} in account ${account || 'to choose'}. Proposed action ${action}, quantity ${quantity}, price ${price || 'unknown'}. Ask for missing facts, explain risk and exit/invalidation. Do not record a trade.`
                    : 'Review my portfolio risk, concentration, downside scenarios and option obligations. No portfolio changes.',
              }),
            )
          }
        >
          Discuss with Advisor
        </button>
      </div>
      <div role="tablist" aria-label="Trade Planner views">
        {['Portfolio Risk', 'Plan a Trade', 'Saved Plans'].map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {busy && <p role="status">Calculating or loading risk…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === 'Portfolio Risk' && summary && (
        <>
          <p>
            Portfolio revision {summary.portfolioRevision} · assessed{' '}
            {new Date(summary.asOf).toLocaleString()} · self-reported holdings
          </p>
          {summary.baseExposure && (
            <article className="card">
              <h2>Consolidated {summary.baseExposure.currency} exposure</h2>
              <p>
                Known gross {summary.baseExposure.knownGross} · known net{' '}
                {summary.baseExposure.knownNet} ·{' '}
                {summary.baseExposure.complete
                  ? 'All positions converted'
                  : 'Incomplete prices or FX'}
              </p>
            </article>
          )}
          {summary.totals.map((t) => (
            <article key={t.currency} className="card">
              <h2>{t.currency} exposure</h2>
              <p>
                Known gross exposure {t.knownGrossExposure} · cash {t.cash} ·{' '}
                {t.complete ? 'All positions marked' : 'Incomplete marks'}
              </p>
              {t.symbols.map((s) => (
                <p key={s.symbol}>
                  {s.symbol}: {s.percentOfKnownGross ?? 'Unknown'}% of known
                  gross {s.concentrated ? '· concentrated' : ''}
                </p>
              ))}
            </article>
          ))}
          <h2>Positions and downside scenarios</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account / underlying</th>
                  <th>Quantity</th>
                  <th>Mark / evidence</th>
                  <th>Delta-equivalent shares</th>
                  <th>−10% shock P&L</th>
                  <th>Expiry</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.accountKey + r.instrumentKey}>
                    <td>
                      {r.accountKey}
                      <br />
                      {r.symbol} · {r.assetType}
                    </td>
                    <td>{r.quantity}</td>
                    <td>
                      {r.mark ?? 'Unknown'} {r.currency}
                      <small>
                        {r.quote
                          ? `${r.quote.provider} · ${r.quote.session} · ${r.quality?.freshness} · ${r.quote.asOf}`
                          : 'No quote'}
                      </small>
                    </td>
                    <td>{r.deltaEquivalent ?? 'Unknown'}</td>
                    <td>
                      {r.scenarios.find((s) => s.shockPercent === -10)?.pnl ??
                        'Unknown'}
                    </td>
                    <td>
                      {r.expiry ?? '—'}{' '}
                      {r.daysToExpiry !== null
                        ? `(${r.daysToExpiry} days${r.daysToExpiry <= summary.thresholds.nearExpiryDays ? ' · review expiry' : ''})`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Short-option obligations</h2>
          {summary.coverage.length ? (
            summary.coverage.map((c) => (
              <p className="notice" key={c.accountKey + c.instrumentKey}>
                {c.accountKey} · {c.symbol} · {c.expiry}: {c.status} · required{' '}
                {c.required}, allocated {c.allocated}, shortfall {c.shortfall}{' '}
                {c.kind === 'CASH_COLLATERAL' ? c.currency : 'shares'}
              </p>
            ))
          ) : (
            <p>No recorded short options.</p>
          )}
          <details>
            <summary>Assumptions and missing data</summary>
            {summary.limitations.map((x) => (
              <p key={x}>{x}</p>
            ))}
          </details>
        </>
      )}
      {tab === 'Plan a Trade' && state && (
        <>
          <p>
            Start with an existing holding or any new ticker. No ownership or
            watchlist membership is required.
          </p>
          {portfolioSelection && (
            <button
              onClick={() => {
                setAccount(portfolioSelection.accountKey);
                const index = state.positions.findIndex(
                  (p) =>
                    p.accountKey === portfolioSelection.accountKey &&
                    instrumentKey(p.instrument) ===
                      portfolioSelection.instrumentKey,
                );
                chooseHolding(index >= 0 ? String(index) : '');
              }}
            >
              Use portfolio selection: {portfolioSelection.label}
            </button>
          )}
          <label>
            Start from
            <select
              aria-label="Start from"
              value={selection === '' ? 'new' : 'holding'}
              onChange={(e) => {
                if (e.target.value === 'new') {
                  chooseHolding('');
                  setSymbol('');
                  setAction('BUY');
                } else {
                  const i = state.positions.findIndex(
                    (p) => p.accountKey === account,
                  );
                  if (i >= 0) chooseHolding(String(i));
                }
              }}
            >
              <option value="new">New ticker</option>
              <option
                value="holding"
                disabled={
                  !state.positions.some((p) => p.accountKey === account)
                }
              >
                Existing holding
              </option>
            </select>
          </label>
          <label>
            Strategy
            <select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value as StrategyInput['strategy']);
                setResult(null);
                setStockResult(null);
              }}
            >
              <option value="STOCK">Stock / ETF</option>
              <option value="COVERED_CALL">Covered call</option>
              <option value="CASH_SECURED_PUT">Cash-secured put</option>
              <option value="LONG_CALL">Long call</option>
              <option value="LONG_PUT">Long put</option>
              <option value="VERTICAL">Vertical spread</option>
            </select>
          </label>
          <div className="risk-fields">
            <label>
              Account
              <select
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  chooseHolding('');
                }}
              >
                {state.accounts.map((a) => (
                  <option key={a.accountKey} value={a.accountKey}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Existing holding
              <select
                aria-label="Existing holding"
                value={selection}
                onChange={(e) => chooseHolding(e.target.value)}
              >
                <option value="">Choose holding or use a new ticker</option>
                {state.positions.map((p, i) => (
                  <option value={i} key={i} hidden={p.accountKey !== account}>
                    {p.accountKey} · {p.instrument.symbol} ·{' '}
                    {p.instrument.assetType}
                  </option>
                ))}
              </select>
            </label>
            {selection === '' ? (
              field('Symbol', symbol, (v) => setSymbol(v.toUpperCase()))
            ) : (
              <p>
                Selected ticker: <strong>{symbol}</strong>
              </p>
            )}
            {!selection && (
              <>
                <label>
                  Asset class
                  <select
                    value={newAsset}
                    onChange={(e) =>
                      setNewAsset(e.target.value as 'STOCK' | 'ETF')
                    }
                  >
                    <option>STOCK</option>
                    <option>ETF</option>
                  </select>
                </label>
                {field('Currency', newCurrency, (v) =>
                  setNewCurrency(v.toUpperCase()),
                )}
              </>
            )}
            {field('Quantity / contracts', quantity, setQuantity)}
            {field('Entry or execution price', price, setPrice)}
            {field('Total fees', fees, setFees)}
            {field('Stop price', stop, setStop)}
            {field('Target price', target, setTarget)}
            {field('Risk budget', budget, setBudget)}
          </div>
          {strategy === 'STOCK' && (
            <>
              <label>
                Proposed action
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value as 'BUY' | 'SELL')}
                >
                  <option>BUY</option>
                  <option>SELL</option>
                </select>
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    setStockResult(
                      await request('risk/stock-trade', {
                        version: 1,
                        accountKey: account,
                        instrument: instrument(),
                        action,
                        quantity,
                        price,
                        fees,
                        stopPrice: stop || null,
                        targetPrice: target || null,
                        riskBudget: budget || null,
                      }),
                    );
                  })
                }
              >
                Analyze stock / ETF trade
              </button>
              {stockResult && (
                <article className="card">
                  <h2>Hypothetical {stockResult.action.toLowerCase()}</h2>
                  <p>
                    Shares: {stockResult.held} → {stockResult.remaining} · cash
                    change {stockResult.cashChange}{' '}
                    {stockResult.instrument.currency}
                  </p>
                  <p>
                    Cash after: {stockResult.cashAfter ?? 'Unknown'} ·{' '}
                    {stockResult.cashSufficient
                      ? 'Cash sufficient'
                      : 'Cash insufficient or unknown'}
                  </p>
                  {stockResult.sizing && (
                    <p>
                      Risk at stop: {stockResult.sizing.riskAtStop ?? 'Unknown'}{' '}
                      · maximum whole shares within budget:{' '}
                      {stockResult.sizing.maxUnits ?? 'Unknown'}
                    </p>
                  )}
                  {stockResult.scenarios.map((s) => (
                    <p key={s.shockPercent}>
                      {s.shockPercent}% shock: before {s.before} → after{' '}
                      {s.after}
                    </p>
                  ))}
                  <p>{stockResult.notice}</p>
                </article>
              )}
            </>
          )}
          <>
            <div className="risk-fields">
              {field('Estimated total slippage', slippage, setSlippage)}
              {strategy !== 'STOCK' && (
                <>
                  {field('Expiry', expiry, setExpiry, 'date')}
                  {field('Strike', strike, setStrike)}
                  {strategy === 'COVERED_CALL' &&
                    field('Stock reference price', sharePrice, setSharePrice)}
                  {strategy === 'VERTICAL' && (
                    <>
                      <label>
                        Right
                        <select
                          value={right}
                          onChange={(e) =>
                            setRight(e.target.value as 'CALL' | 'PUT')
                          }
                        >
                          <option>CALL</option>
                          <option>PUT</option>
                        </select>
                      </label>
                      {field('Second strike', secondStrike, setSecondStrike)}
                      {field('Second leg price', secondPrice, setSecondPrice)}
                    </>
                  )}
                </>
              )}
            </div>
            {strategy === 'STOCK' && action === 'SELL' ? (
              <p>
                Use the sale analysis above to review proceeds and remaining
                exposure. Review the plan below before saving.
              </p>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () =>
                    setResult(await request('strategies/evaluate', analysis())),
                  )
                }
              >
                Calculate payoff
              </button>
            )}
            {result && (
              <article className="card">
                <h2>
                  {result.symbol} hypothetical payoff{' '}
                  {result.expiry ? 'at expiry' : 'by share price'}
                </h2>
                <p>
                  Max profit:{' '}
                  {result.unboundedProfit ? 'Unbounded' : result.maxProfit} ·
                  max loss:{' '}
                  {result.unboundedLoss ? 'Unbounded' : result.maxLoss}{' '}
                  {result.currency} · break-even:{' '}
                  {result.breakEven.join(', ') || 'None'}
                </p>
                <PayoffChart points={result.points} />
                {result.limitations.map((x) => (
                  <p key={x}>{x}</p>
                ))}
              </article>
            )}
            <details>
              <summary>Build a reviewable trade plan</summary>
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const session = await request<{
                      history: Array<{
                        kind: string;
                        output?: { assessment?: Assessment };
                      }>;
                    }>('chat/sessions/risk');
                    const draft = session.history.findLast(
                      (h) => h.kind === 'tool_result' && h.output?.assessment,
                    )?.output?.assessment;
                    if (!draft)
                      throw new Error(
                        'Ask Advisor to prepare a trade plan first, with entry, exit, invalidation and main risk.',
                      );
                    const checked = await request<{ assessment: Assessment }>(
                      'risk/plans/preview',
                      draft.input,
                    );
                    setPreview({
                      assessment: checked.assessment,
                      input: draft.input,
                    });
                  })
                }
              >
                Load latest Advisor plan draft
              </button>
              <div className="risk-fields">
                {field('Entry condition', entryCondition, setEntryCondition)}
                {field('Exit / profit-taking condition', exit, setExit)}
                {field('Invalidation condition', invalidation, setInvalidation)}
                {field('Main risk', mainRisk, setMainRisk)}
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => {
                    setReviewed(e.target.checked);
                    setPreview(null);
                  }}
                />{' '}
                I reviewed current holdings and cash
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const input: PlanInput = {
                      version: 1,
                      idempotencyKey: crypto.randomUUID(),
                      portfolioRevision: summary!.portfolioRevision,
                      analysis: analysis(),
                      stockAction: action,
                      entryCondition,
                      invalidation,
                      target: exit,
                      mainRisk,
                      riskBudget: budget || null,
                      stopPrice: stop || null,
                      targetPrice: target || null,
                      portfolioReviewed: reviewed,
                    };
                    const p = await request<{ assessment: Assessment }>(
                      'risk/plans/preview',
                      input,
                    );
                    setPreview({ ...p, input });
                  })
                }
              >
                Review plan
              </button>
              {preview && (
                <article className="notice">
                  <h3>Watch-only plan</h3>
                  <p>
                    {preview.input.analysis.accountKey} ·{' '}
                    {preview.input.analysis.strategy} ·{' '}
                    {preview.input.stockAction} · revision{' '}
                    {preview.input.portfolioRevision}
                  </p>
                  {preview.input.analysis.legs.map((l, i) => (
                    <p key={i}>
                      {l.instrument.symbol}{' '}
                      {l.instrument.optionRight ?? l.instrument.assetType}{' '}
                      {l.instrument.strike ?? ''} {l.instrument.expiry ?? ''}:
                      quantity {l.quantity}, reference price {l.entryPrice}{' '}
                      {l.instrument.currency}
                    </p>
                  ))}
                  <p>
                    Fees {preview.input.analysis.fees} · slippage{' '}
                    {preview.input.analysis.slippage ?? 'Unknown'} · entry:{' '}
                    {preview.input.entryCondition} · invalidation:{' '}
                    {preview.input.invalidation}
                  </p>
                  {preview.assessment.stockTrade && (
                    <p>
                      {preview.assessment.stockTrade.action}:{' '}
                      {preview.assessment.stockTrade.held} →{' '}
                      {preview.assessment.stockTrade.remaining} shares;
                      estimated cash change{' '}
                      {preview.assessment.stockTrade.cashChange}
                    </p>
                  )}
                  {preview.assessment.reasons.map((r) => (
                    <p key={r}>{r}</p>
                  ))}
                  <p>
                    Main risk: {preview.assessment.mainRisk} · exit:{' '}
                    {preview.assessment.exit}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        await request('risk/plans', preview.input);
                        setNotice('Plan saved. No order or portfolio change.');
                        setPlans(await request('risk/plans'));
                        setPreview(null);
                      })
                    }
                  >
                    Save hypothetical plan
                  </button>
                </article>
              )}
            </details>
          </>
        </>
      )}
      {tab === 'Saved Plans' && (
        <>
          {plans.length ? (
            plans.map((p) => (
              <article className="card" key={p.id}>
                <h2>
                  {p.assessment.result.symbol} · {p.assessment.result.strategy}
                </h2>
                <p>
                  WATCH_ONLY · assessed{' '}
                  {new Date(p.assessment.asOf).toLocaleString()} · historical
                  assessment, not a current recommendation
                </p>
                <p>Entry: {p.assessment.input.entryCondition}</p>
                <p>
                  Exit: {p.assessment.exit} · invalidation:{' '}
                  {p.assessment.invalidation}
                </p>
                <p>Main risk: {p.assessment.mainRisk}</p>
                <details>
                  <summary>Data gaps and assumptions</summary>
                  {p.assessment.reasons.map((r) => (
                    <p key={r}>{r}</p>
                  ))}
                </details>
              </article>
            ))
          ) : (
            <p>
              No saved plans. Analyze a stock or option strategy and review a
              plan first.
            </p>
          )}
        </>
      )}
    </section>
  );
}
function PayoffChart({
  points,
}: {
  points: Array<{ price: string; pnl: string }>;
}) {
  const xs = points.map((p) => Number(p.price)),
    ys = points.map((p) => Number(p.pnl)),
    xmax = Math.max(...xs, 1),
    lo = Math.min(...ys, 0),
    hi = Math.max(...ys, 0),
    span = hi - lo || 1;
  return (
    <svg
      viewBox="0 0 600 220"
      role="img"
      aria-label="Hypothetical profit and loss by underlying price"
    >
      <line
        x1="30"
        x2="580"
        y1={190 - ((0 - lo) / span) * 160}
        y2={190 - ((0 - lo) / span) * 160}
        stroke="currentColor"
        opacity=".3"
      />
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        points={points
          .map(
            (p) =>
              `${30 + (Number(p.price) / xmax) * 550},${190 - ((Number(p.pnl) - lo) / span) * 160}`,
          )
          .join(' ')}
      />
      <text x="30" y="215">
        Underlying price: 0
      </text>
      <text x="470" y="215">
        {xmax.toFixed(2)}
      </text>
      <text x="30" y="18">
        P&amp;L: {lo.toFixed(2)} to {hi.toFixed(2)}
      </text>
    </svg>
  );
}
