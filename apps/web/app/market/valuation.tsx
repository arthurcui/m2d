'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import type { Valuation } from '@m2d/market';
type FeedRequest =
  | { kind: 'quote'; instrument: import('@m2d/portfolio').Instrument }
  | { kind: 'options'; symbol: string; expiry: string }
  | { kind: 'fx'; base: string; quote: string };
export type ValuationView = Valuation & {
  portfolioRevision: number;
  requests: FeedRequest[];
  provider: string;
};
export function marketTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString('en-CA', {
        timeZone: 'America/Vancouver',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' Vancouver'
    : 'Unavailable';
}
export async function marketApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/v1/${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = (await response.json()) as {
    data: T;
    error?: { message: string };
  };
  if (!response.ok)
    throw new Error(result.error?.message ?? 'Market request failed.');
  return result.data;
}
export function ValuationPanel() {
  const stop = useRef(false);
  const [value, setValue] = useState<ValuationView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [history, setHistory] = useState<
    Array<{
      id: string;
      portfolioRevision: number;
      computedAt: string;
      valuation: Valuation;
    }>
  >([]);
  const load = useCallback(async () => {
    try {
      const v = await marketApi<ValuationView>('portfolio/valuation');
      setValue(v);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Valuation unavailable.');
    }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener('m2d-market-updated', load);
    return () => {
      stop.current = true;
      window.removeEventListener('m2d-market-updated', load);
    };
  }, [load]);
  async function refresh() {
    if (!value) return;
    stop.current = false;
    setBusy(true);
    setError('');
    const failures: string[] = [];
    try {
      // Explicit user-triggered bounded refresh; navigation never starts paid calls.
      const eligible = value.requests.filter(
        (r) => value.provider === 'fixture' || r.kind !== 'options',
      );
      if (eligible.length !== value.requests.length)
        failures.push(
          'Licensed option prices unavailable; stock and FX feeds refreshed separately.',
        );
      const requests = eligible.slice(0, 50);
      for (const [i, request] of requests.entries()) {
        if (stop.current) break;
        const label =
          request.kind === 'quote'
            ? `${request.instrument.symbol} (${request.instrument.exchange})`
            : request.kind === 'options'
              ? `${request.symbol} ${request.expiry}`
              : `${request.base}/${request.quote}`;
        setProgress(
          `Refreshing ${label} · ${i + 1} of ${requests.length} sources…`,
        );
        const result = await marketApi<{
          status: string;
          errorCode: string | null;
        }>('market/refresh', {
          version: 1,
          idempotencyKey: crypto.randomUUID(),
          request,
        });
        if (result.status !== 'SUCCEEDED')
          failures.push(`${label}: ${result.errorCode ?? result.status}`);
        if (value.provider !== 'fixture' && i < requests.length - 1) {
          if (result.status === 'FAILED') break;
          await new Promise((r) => setTimeout(r, 8100));
        }
      }
      await load();
      if (value.requests.length > 50)
        failures.push('Refresh limited to 50 sources.');
      setError(failures.join(' · '));
      setProgress(
        stop.current
          ? 'Refresh stopped. Completed sources are kept.'
          : 'Refresh finished. Missing sources remain unpriced.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await marketApi('market/snapshots', {
        version: 1,
        idempotencyKey: crypto.randomUUID(),
      });
      setHistory(await marketApi('market/snapshots'));
      setProgress(
        'Valuation snapshot saved. Portfolio holdings are unchanged.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snapshot failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="workspace-card market-valuation"
      aria-label="Portfolio valuation"
    >
      <div className="card-heading">
        <h2>Portfolio valuation</h2>
        {busy && (
          <button
            onClick={() => {
              stop.current = true;
            }}
          >
            Stop refreshing
          </button>
        )}
        <button disabled={busy || !value} onClick={() => void refresh()}>
          Refresh portfolio prices
        </button>
      </div>
      <p className="card-note">
        {value?.provider === 'fixture'
          ? 'Synthetic fixture prices — not actual portfolio value.'
          : 'Indicative valuation from stored market evidence.'}{' '}
        Prices are never substituted for a reported trade price.
      </p>
      {value && (
        <>
          <div className="market-kpis">
            <div>
              <span>
                {value.nav === null
                  ? 'Known subtotal · incomplete'
                  : 'Net asset value'}
              </span>
              <strong>
                {value.nav ?? value.knownValue} {value.baseCurrency}
              </strong>
            </div>
            <div>
              <span>Coverage</span>
              <strong>{value.quality}</strong>
              <small>{value.missing} unpriced holding / cash balances</small>
            </div>
          </div>
          <p className="card-note">
            Revision {value.portfolioRevision} · Computed{' '}
            {marketTime(value.computedAt)} · Prices{' '}
            {marketTime(value.oldestAsOf)}
            {value.mixedTimestamps ? ' · MIXED TIMESTAMPS' : ''}
          </p>
          <details>
            <summary>Holdings, unrealized P&amp;L and source evidence</summary>
            <div className="market-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Account / holding</th>
                    <th>Mark</th>
                    <th>Value</th>
                    <th>Unrealized P&amp;L</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {value.positions.map((p) => (
                    <tr key={p.accountKey + p.instrumentKey}>
                      <td>
                        {p.accountKey} · {p.symbol}
                        <small>{p.quantity} units</small>
                      </td>
                      <td>
                        {p.mark ?? 'Unavailable'} {p.currency}
                        <small>{p.markPolicy}</small>
                      </td>
                      <td>
                        {p.marketValue ?? 'Unavailable'} {p.currency}
                      </td>
                      <td>
                        {p.unrealized ?? 'Unknown'} {p.currency}
                        <small>{p.costQuality}</small>
                      </td>
                      <td>
                        {p.quote
                          ? `${p.quote.provider} · ${p.quote.session} · ${p.quality?.freshness} · ${p.quote.quality}`
                          : 'No matching quote'}
                        <small>
                          {marketTime(p.quote?.asOf ?? null)} · delay{' '}
                          {p.quote?.delayedMinutes ?? 'unknown'} min
                        </small>
                        {p.fx && (
                          <small>
                            FX {p.fx.rate} · {p.fx.provider} ·{' '}
                            {marketTime(p.fx.asOf)}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Cash:{' '}
              {value.cash
                .map(
                  (c) =>
                    `${c.accountKey}: ${c.balance} ${c.currency}${c.fx ? ` (FX ${c.fx.rate}, ${marketTime(c.fx.asOf)})` : c.value === null ? ' — missing FX' : ''}`,
                )
                .join(' · ') || 'No recorded cash.'}
            </p>
          </details>
          <p className="card-note">
            Unrealized P&amp;L uses recorded unit cost and excludes unrecorded
            fees. Pre-baseline realized P&amp;L and historical performance
            remain unknown. NAV changes are not investment returns.
          </p>
          <div className="market-actions">
            <button disabled={busy} onClick={() => void save()}>
              Save valuation snapshot
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void marketApi<typeof history>('market/snapshots')
                  .then(setHistory)
                  .catch(() => setError('History unavailable.'));
              }}
            >
              Show saved valuations
            </button>
          </div>
          {!!history.length && (
            <details open>
              <summary>Saved valuations</summary>
              <ul>
                {history.map((h) => (
                  <li key={h.id}>
                    {marketTime(h.computedAt)} · revision {h.portfolioRevision}{' '}
                    · {h.valuation.nav ?? 'Incomplete'}{' '}
                    {h.valuation.baseCurrency} · {h.valuation.quality}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {progress && <p role="status">{progress}</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </section>
  );
}
