'use client';
import { useEffect, useState } from 'react';
import type { Bar, OptionSnapshot, Quote } from '@m2d/market';
import { marketApi, marketTime, ValuationPanel } from './valuation';
type RecordValue<T> = { payload: { value: T } } | null;
export function MarketPanel() {
  const [symbol, setSymbol] = useState('TSLA'),
    [exchange, setExchange] = useState('NASDAQ');
  const [expiry, setExpiry] = useState('2026-12-18');
  const [status, setStatus] = useState<{
    provider: string;
    configured: boolean;
    session: string;
    options: string;
  } | null>(null);
  const [bars, setBars] = useState<Bar[]>([]),
    [quote, setQuote] = useState<Quote | null>(null),
    [options, setOptions] = useState<OptionSnapshot[] | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void marketApi<typeof status>('market/status')
      .then(setStatus)
      .catch(() => setError('Market status unavailable.'));
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem('m2d.market.selection.v1') ?? 'null',
      );
      if (
        saved &&
        typeof saved === 'object' &&
        'symbol' in saved &&
        typeof saved.symbol === 'string' &&
        /^[A-Z0-9.^-]{1,24}$/.test(saved.symbol) &&
        'exchange' in saved &&
        typeof saved.exchange === 'string' &&
        ['NASDAQ', 'NYSE', 'AMEX'].includes(saved.exchange) &&
        'expiry' in saved &&
        typeof saved.expiry === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(saved.expiry)
      ) {
        const selection = {
          symbol: saved.symbol,
          exchange: saved.exchange,
          expiry: saved.expiry,
        };
        setSymbol(selection.symbol);
        setExchange(selection.exchange);
        setExpiry(selection.expiry);
        void load(selection).catch(() =>
          setError('Stored market data unavailable.'),
        );
      }
    } catch {
      /* Browser storage is optional; market evidence stays in PostgreSQL. */
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored)
      try {
        sessionStorage.setItem(
          'm2d.market.selection.v1',
          JSON.stringify({ symbol, exchange, expiry }),
        );
      } catch {
        /* Optional browser preference. */
      }
  }, [restored, symbol, exchange, expiry]);
  async function load(selection = { symbol, exchange, expiry }) {
    const { symbol, exchange, expiry } = selection;
    const [q, b, o] = await Promise.all([
      marketApi<RecordValue<Quote>>(
        `market/quotes?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}`,
      ),
      marketApi<RecordValue<Bar[]>>(
        `market/bars/${encodeURIComponent(symbol)}?exchange=${exchange}`,
      ),
      marketApi<RecordValue<OptionSnapshot[]>>(
        `market/options/${encodeURIComponent(symbol)}?expiry=${expiry}`,
      ),
    ]);
    setQuote(q?.payload.value ?? null);
    setBars(b?.payload.value ?? []);
    setOptions(o?.payload.value ?? null);
  }
  async function refresh(kind: 'quote' | 'bars' | 'options') {
    setBusy(true);
    setError('');
    try {
      const request =
        kind === 'quote'
          ? {
              kind,
              instrument: {
                assetType: 'STOCK',
                symbol,
                exchange,
                currency: 'USD',
                optionRight: null,
                expiry: null,
                strike: null,
                multiplier: '1',
                underlying: null,
                deliverable: null,
              },
            }
          : kind === 'options'
            ? { kind, symbol, expiry }
            : { kind, symbol, exchange };
      const result = await marketApi<{
        status: string;
        errorCode: string | null;
      }>('market/refresh', {
        version: 1,
        idempotencyKey: crypto.randomUUID(),
        request,
      });
      await load();
      window.dispatchEvent(new Event('m2d-market-updated'));
      if (result.status !== 'SUCCEEDED')
        setError(
          result.errorCode === 'OPTIONS_UNAVAILABLE'
            ? (status?.options ?? 'Options unavailable.')
            : `Refresh ${result.status.toLowerCase()}: ${result.errorCode ?? 'interrupted'}. Previously stored data is unchanged.`,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="workspace-card market-view" aria-label="Market data">
        <div className="card-heading">
          <h2>Market data</h2>
          <span className="quality-badge">
            {status?.provider ?? 'Checking'} · {status?.session ?? 'UNKNOWN'}
          </span>
        </div>
        <p>
          {status?.provider === 'fixture'
            ? 'Offline synthetic examples. These are not real market prices.'
            : status?.configured
              ? 'Configured provider. Refreshes use your data plan; allow 8 seconds between requests.'
              : 'Set TWELVE_DATA_API_KEY in the backend environment to enable market requests.'}
        </p>
        <div className="market-controls">
          <label>
            Symbol
            <input
              disabled={busy}
              value={symbol}
              maxLength={24}
              onChange={(e) => {
                setSymbol(e.target.value.toUpperCase());
                setQuote(null);
                setBars([]);
                setOptions(null);
              }}
            />
          </label>
          <label>
            Exchange
            <select
              disabled={busy}
              value={exchange}
              onChange={(e) => {
                setExchange(e.target.value);
                setQuote(null);
                setBars([]);
              }}
            >
              <option>NASDAQ</option>
              <option>NYSE</option>
              <option>AMEX</option>
            </select>
          </label>
          <label>
            Option expiry
            <input
              disabled={busy}
              type="date"
              value={expiry}
              onChange={(e) => {
                setExpiry(e.target.value);
                setOptions(null);
              }}
            />
          </label>
        </div>
        <div className="market-actions">
          <button disabled={busy} onClick={() => void refresh('quote')}>
            Refresh quote
          </button>
          <button disabled={busy} onClick={() => void refresh('bars')}>
            Refresh chart
          </button>
          <button disabled={busy} onClick={() => void refresh('options')}>
            Refresh options
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void load().catch(() => setError('Stored data unavailable.'));
            }}
          >
            Load stored data
          </button>
        </div>
        {busy && <p role="status">Refreshing selected feed…</p>}
        <p className="card-note">{status?.options}</p>
        {!quote && (
          <p className="card-note">
            No stored quote selected. Refresh quote or load available evidence.
          </p>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {quote && (
          <div className="market-quote">
            <strong>
              {quote.last} {quote.instrument.currency}
            </strong>
            <p>
              {quote.instrument.symbol} · {quote.instrument.exchange} ·{' '}
              {quote.kind} · {quote.provider} · {quote.session} ·{' '}
              {quote.quality}
            </p>
            <small>
              As of {marketTime(quote.asOf)} · delay{' '}
              {quote.delayedMinutes ?? 'unknown'} min ·{' '}
              {Date.now() - Date.parse(quote.asOf) > 90000 ? 'STALE' : 'recent'}{' '}
              · WATCH_ONLY
            </small>
          </div>
        )}
        <PriceChart bars={bars} />
        {options && (
          <div className="market-table-scroll">
            <h3>Option snapshots</h3>
            <p>{status?.options}</p>
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Bid / ask</th>
                  <th>Greeks / IV</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {options.map((o) => (
                  <tr key={o.quote.sourceRecordId}>
                    <td>
                      {o.quote.instrument.symbol} {o.quote.instrument.strike}{' '}
                      {o.quote.instrument.optionRight}{' '}
                      {o.quote.instrument.expiry}
                    </td>
                    <td>
                      {o.quote.bid ?? '—'} / {o.quote.ask ?? '—'}{' '}
                      {o.quote.instrument.currency}
                    </td>
                    <td>
                      {o.delta === null ? 'Unavailable' : `Delta ${o.delta}`} ·
                      IV {o.iv ?? 'unavailable'}
                    </td>
                    <td>
                      {o.quote.provider} · {o.quote.quality} · {o.quote.session}
                      <small>
                        {marketTime(o.quote.asOf)} · delay{' '}
                        {o.quote.delayedMinutes ?? 'unknown'} min
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ValuationPanel />
    </>
  );
}
function PriceChart({ bars }: { bars: Bar[] }) {
  if (!bars.length)
    return (
      <p className="card-note">
        Refresh or load stored OHLCV bars to view the chart.
      </p>
    );
  // Number conversion is only for SVG pixel coordinates; stored prices remain decimal strings.
  const low = Math.min(...bars.map((b) => Number(b.low))),
    high = Math.max(...bars.map((b) => Number(b.high)));
  const y = (v: string) => 180 - ((Number(v) - low) / (high - low || 1)) * 150;
  const maxVolume = Math.max(1, ...bars.map((b) => Number(b.volume ?? 0)));
  return (
    <figure className="market-chart">
      <svg
        viewBox="0 0 640 240"
        role="img"
        aria-label={`${bars[0]!.symbol} hourly OHLCV chart`}
      >
        <text x="0" y="16">
          {high} {bars[0]!.currency}
        </text>
        {bars.map((b, i) => {
          const x = 55 + (i * 565) / bars.length;
          return (
            <g key={b.start}>
              <title>
                {b.symbol} · {b.start} · O {b.open} H {b.high} L {b.low} C{' '}
                {b.close} · volume {b.volume ?? 'unknown'} · {b.provider} ·{' '}
                {b.session} · {b.quality} · delay{' '}
                {b.delayedMinutes ?? 'unknown'} min
              </title>
              <line
                x1={x}
                x2={x}
                y1={y(b.high)}
                y2={y(b.low)}
                stroke="currentColor"
              />
              <rect
                x={x - 3}
                width="6"
                y={Math.min(y(b.open), y(b.close))}
                height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                fill={Number(b.close) >= Number(b.open) ? '#12644c' : '#a44435'}
              />
              <rect
                x={x - 3}
                width="6"
                y={230 - (35 * Number(b.volume ?? 0)) / maxVolume}
                height={(35 * Number(b.volume ?? 0)) / maxVolume}
                fill="#8a9f96"
              />
            </g>
          );
        })}
        <text x="0" y="185">
          {low}
        </text>
      </svg>
      <figcaption>
        {bars[0]!.symbol} · {bars[0]!.exchange} · {bars[0]!.provider} ·{' '}
        {bars[0]!.quality} · unadjusted hourly bars ·{' '}
        {marketTime(bars[0]!.start)} – {marketTime(bars.at(-1)!.asOf)}. Hover
        for OHLCV and session.
      </figcaption>
      <details>
        <summary>Accessible OHLCV data</summary>
        <div className="market-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Start (UTC)</th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Close</th>
                <th>Volume</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.start}>
                  <td>{b.start}</td>
                  <td>{b.open}</td>
                  <td>{b.high}</td>
                  <td>{b.low}</td>
                  <td>{b.close}</td>
                  <td>{b.volume ?? 'Unavailable'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
