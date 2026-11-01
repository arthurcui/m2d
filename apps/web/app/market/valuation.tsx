'use client';
import { useState } from 'react';
import { useMarketData } from './market-context';
import { marketTime, marketApi } from './market-client';
import type { Valuation } from '@m2d/market';
export type { ValuationView } from './market-context';
export { marketTime, marketApi } from './market-client';
export function ValuationPanel() {
  const {
    value,
    error,
    busy,
    listingBusy,
    progress,
    stop,
    refresh,
    setBusy,
    setError,
    setProgress,
  } = useMarketData();
  const [history, setHistory] = useState<
    Array<{
      id: string;
      portfolioRevision: number;
      computedAt: string;
      valuation: Valuation;
    }>
  >([]);
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
              stop();
            }}
          >
            Stop refreshing
          </button>
        )}
        <button
          disabled={busy || listingBusy || !value}
          onClick={() => void refresh()}
        >
          Refresh portfolio prices
        </button>
      </div>
      <p className="card-note">
        {value?.provider === 'fixture'
          ? 'Synthetic fixture prices — not actual portfolio value.'
          : value?.provider === 'massive'
            ? 'Massive Basic: end-of-day valuation, not live prices. New holdings refresh gradually within the free allowance.'
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
                        {p.quote?.resolvedExchange && (
                          <small>
                            Provider listing: {p.quote.resolvedExchange}
                          </small>
                        )}
                        <small>
                          {p.quote?.kind === 'EOD_CLOSE'
                            ? 'Daily period ending '
                            : ''}
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
