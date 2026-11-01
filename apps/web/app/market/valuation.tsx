'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { marketTime, marketApi } from './market-client';
import { refreshListingDetails } from './listing-details';
import type { Valuation } from '@m2d/market';
import { isMarketSourceFailure, marketFailureMessage } from '@m2d/market';
type FeedRequest =
  | { kind: 'quote'; instrument: import('@m2d/portfolio').Instrument }
  | { kind: 'options'; symbol: string; expiry: string }
  | { kind: 'fx'; base: string; quote: string };
export type ValuationView = Valuation & {
  portfolioRevision: number;
  requests: FeedRequest[];
  provider: string;
  refreshIntervalMs: number;
};
export { marketTime, marketApi } from './market-client';
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
    let completed = 0;
    let halted = false;
    try {
      // Explicit user-triggered bounded refresh; navigation never starts paid calls.
      const eligible = value.requests.filter(
        (r) =>
          (['fixture', 'ibkr'].includes(value.provider) ||
            r.kind !== 'options') &&
          (!['massive', 'ibkr'].includes(value.provider) || r.kind !== 'fx'),
      );
      if (eligible.length !== value.requests.length)
        failures.push(
          ['massive', 'ibkr'].includes(value.provider)
            ? 'FX unavailable on this configuration; non-USD balances remain unconverted.'
            : 'Licensed option prices unavailable; stock and FX feeds refreshed separately.',
        );
      const requests = eligible.slice(0, 50);
      for (const [i, request] of requests.entries()) {
        if (stop.current) break;
        const label =
          request.kind === 'quote'
            ? `${request.instrument.symbol}${request.instrument.assetType === 'OPTION' ? ` ${request.instrument.expiry} ${request.instrument.strike} ${request.instrument.optionRight}` : ''}${['UNKNOWN', 'US', 'SMART'].includes(request.instrument.exchange) ? '' : ` (${request.instrument.exchange})`}`
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
        if (result.status !== 'SUCCEEDED') {
          failures.push(`${label}: ${marketFailureMessage(result.errorCode)}`);
          halted = !isMarketSourceFailure(result.errorCode);
        } else completed++;
        // Basic batches can take minutes: show each completed source immediately.
        await load();
        setError(failures.join(' · '));
        if (halted) break;
        if (value.provider !== 'fixture' && i < requests.length - 1) {
          if (value.refreshIntervalMs)
            await new Promise((r) => setTimeout(r, value.refreshIntervalMs));
        }
      }
      await load();
      if (!stop.current && !halted) {
        try {
          await refreshListingDetails(setProgress, () => stop.current);
        } catch (e) {
          failures.push(
            'Prices are kept. ' +
              (e instanceof Error
                ? e.message
                : 'Listing details could not be refreshed.'),
          );
        }
      }
      if (value.requests.length > 50)
        failures.push('Refresh limited to 50 sources.');
      setError(failures.join(' · '));
      setProgress(
        stop.current
          ? 'Refresh stopped. Completed sources are kept.'
          : halted
            ? `Refresh stopped after ${completed} successful sources. Completed values are kept; see the provider error below.`
            : `Refresh finished. ${completed} of ${requests.length} sources updated or loaded from cache. Missing sources remain unpriced.`,
      );
    } catch (e) {
      await load();
      setError(e instanceof Error ? e.message : 'Refresh failed.');
      setProgress(
        `Refresh stopped after ${completed} successful sources. Completed values are kept.`,
      );
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
