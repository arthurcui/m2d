'use client';
import { useEffect, useRef, useState } from 'react';
import type { Bar, ListingCandidate, ListingResolution } from '@m2d/market';
import { useMarketData } from '../market/market-context';
import { marketApi, marketTime } from '../market/market-client';
import {
  financialSeries,
  displayFinancialValue,
  metricLabel,
  seriesKey,
  type ChartFact,
  type PeriodKind,
} from './chart-data';

type EventDoc = {
  id: string;
  title: string;
  form: string;
  provider: string;
  published_at: string | null;
  available_at: string;
};
type StoredBars = {
  id: string;
  availableAt: string;
  payload: { kind: 'bars'; value: Bar[] };
} | null;
const compact = (n: number) =>
  new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n);
const day = (s: string) =>
  new Date(s).toLocaleString('en-CA', {
    timeZone: 'America/Vancouver',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const discuss = (message: string) =>
  window.dispatchEvent(
    new CustomEvent('m2d:research-discuss', { detail: message }),
  );
// Floating point is used only for pixel positions/axis labels; source values stay exact strings.
function coordinates(values: string[], zero = false) {
  const numbers = values.map(Number);
  const min = Math.min(...numbers, ...(zero ? [0] : []));
  const max = Math.max(...numbers, ...(zero ? [0] : []));
  const padding = (max - min || Math.abs(max) || 1) * 0.08;
  return {
    min,
    max,
    y: (v: string | number) =>
      188 - ((Number(v) - min + padding) / (max - min + 2 * padding)) * 160,
  };
}
function Axis({
  min,
  max,
  y,
}: {
  min: number;
  max: number;
  y: (v: string | number) => number;
}) {
  return (
    <>
      <line x1="70" x2="660" y1={y(max)} y2={y(max)} className="chart-grid" />
      <line x1="70" x2="660" y1={y(min)} y2={y(min)} className="chart-grid" />
      <text x="4" y={y(max) + 4}>
        {compact(max)}
      </text>
      <text x="4" y={y(min) + 4}>
        {compact(min)}
      </text>
    </>
  );
}
export function CompanyCharts({
  symbol,
  at,
  active,
  facts,
  documents,
  onOpen,
}: {
  symbol: string;
  at?: string | undefined;
  active: boolean;
  facts: ChartFact[];
  documents: EventDoc[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="company-charts" aria-label="Company charts">
      <PriceEvents
        symbol={symbol}
        at={at}
        active={active}
        documents={documents}
        onOpen={onOpen}
      />
      <FinancialTrend symbol={symbol} at={at} facts={facts} onOpen={onOpen} />
    </section>
  );
}
function PriceEvents({
  symbol,
  at,
  active,
  documents,
  onOpen,
}: Omit<Parameters<typeof CompanyCharts>[0], 'facts'>) {
  const { settings } = useMarketData();
  const provider = settings?.priceProvider;
  const [resolution, setResolution] = useState<{
    value: ListingResolution;
    for: string;
  } | null>(null);
  const [choice, setChoice] = useState('');
  const scope = `${symbol}|${provider}|${at ?? ''}`;
  const candidates =
    resolution?.for === scope ? resolution.value.candidates : [];
  const listing =
    candidates.find((c) => c.id === choice) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const exchange = listing?.exchange;
  const [phase, setPhase] = useState('Refreshing history…');
  useEffect(() => {
    setChoice('');
  }, [scope]);
  useEffect(() => {
    if (!active || !provider) return;
    let live = true;
    void marketApi<{ payload: { value: ListingResolution } } | null>(
      `market/resolutions/${encodeURIComponent(symbol)}${at ? `?at=${encodeURIComponent(at)}` : ''}`,
    )
      .then((r) => {
        if (live)
          setResolution(
            r && r.payload.value.provider === provider
              ? { value: r.payload.value, for: scope }
              : null,
          );
      })
      .catch(() => {
        if (live)
          setError(
            'Stored listing identity could not be loaded. Refresh to retry.',
          );
      });
    return () => {
      live = false;
    };
  }, [scope, active]);
  const [record, setRecord] = useState<StoredBars>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const identity = `${scope}|${listing?.id ?? ''}`;
  const current = useRef(scope);
  current.current = scope;
  useEffect(
    () => () => {
      current.current = 'unmounted';
    },
    [],
  );
  const [recordFor, setRecordFor] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    if (!active || !provider || !listing) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError('');
    void marketApi<StoredBars>(
      `market/bars/${encodeURIComponent(symbol)}?exchange=${exchange}&listingId=${encodeURIComponent(listing!.id)}${at ? `&at=${encodeURIComponent(at)}` : ''}`,
    )
      .then((r) => {
        if (live) {
          setRecord(r);
          setRecordFor(identity);
        }
      })
      .catch((e) => {
        if (live)
          setError(
            e instanceof Error
              ? e.message
              : 'Price history could not be loaded.',
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [symbol, exchange, listing?.id, provider, at, active, reload]);
  const bars = (recordFor === identity ? (record?.payload.value ?? []) : [])
    .filter(
      (b) =>
        b.provider === provider &&
        b.symbol === symbol &&
        b.exchange === exchange &&
        (!at || Date.parse(b.availableAt) <= Date.parse(at)),
    )
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  const selectedBar = bars.find((b) => b.asOf === selected) ?? bars.at(-1);
  const first = bars[0],
    last = bars.at(-1);
  const x = (time: string) =>
    70 +
    ((Date.parse(time) - Date.parse(first!.asOf)) /
      (Date.parse(last!.asOf) - Date.parse(first!.asOf) || 1)) *
      590;
  const plot = bars.length ? coordinates(bars.map((b) => b.close)) : null;
  const allEvents = documents.filter(
    (d) =>
      d.form !== 'INDEX' &&
      d.form !== 'XBRL' &&
      d.published_at &&
      (!at || Date.parse(d.available_at) <= Date.parse(at)),
  );
  const events =
    first && last
      ? allEvents
          .filter(
            (d) =>
              Date.parse(d.published_at!) >= Date.parse(first.asOf) &&
              Date.parse(d.published_at!) <= Date.parse(last.asOf),
          )
          .slice(0, 20)
      : [];
  async function refresh(preferred?: string) {
    if (inFlight.current || at || !provider) return;
    const requested = scope;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setPhase('Resolving listing…');
      const resolved = await marketApi<{
        status: string;
        errorCode: string | null;
      }>('market/refresh', {
        version: 1,
        idempotencyKey: crypto.randomUUID(),
        expectedProvider: provider,
        request: { kind: 'resolution', symbol },
      });
      if (current.current !== requested) return;
      if (resolved.status !== 'SUCCEEDED')
        throw new Error(
          `Listing resolution failed: ${resolved.errorCode ?? resolved.status}. Try again later.`,
        );
      const result = await marketApi<{
        payload: { value: ListingResolution };
      } | null>(`market/resolutions/${encodeURIComponent(symbol)}`);
      if (
        current.current !== requested ||
        result?.payload.value.provider !== provider
      )
        return;
      setResolution({ value: result.payload.value, for: scope });
      const matches = result.payload.value.candidates;
      const chosen: ListingCandidate | undefined =
        matches.find((c) => c.id === (preferred ?? choice)) ??
        (matches.length === 1 ? matches[0] : undefined);
      if (!chosen) return;
      setChoice(chosen.id);
      if (provider === 'twelvedata') {
        setPhase('Listing resolved; waiting for provider request window…');
        await new Promise((resolve) => setTimeout(resolve, 8000));
        if (current.current !== requested) return;
      }
      setPhase('Refreshing history…');
      const r = await marketApi<{ status: string; errorCode: string | null }>(
        'market/refresh',
        {
          version: 1,
          idempotencyKey: crypto.randomUUID(),
          expectedProvider: provider,
          request: {
            kind: 'bars',
            symbol,
            exchange: chosen.exchange,
            listingId: chosen.id,
          },
        },
      );
      if (current.current !== requested) return;
      if (r.status !== 'SUCCEEDED')
        throw new Error(
          `Price history refresh failed: ${r.errorCode ?? r.status}. Stored history is kept.`,
        );
      setReload((n) => n + 1);
    } catch (e) {
      if (current.current === requested)
        setError(
          e instanceof Error ? e.message : 'Price history refresh failed.',
        );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="company-chart-card" aria-label="Price and events">
      <div className="research-heading">
        <div>
          <span className="eyebrow">MARKET CONTEXT</span>
          <h2>{symbol} · Price & events</h2>
        </div>
        <span className="quality-badge">
          {provider ?? 'Checking source'}
          {provider === 'fixture' ? ' · synthetic' : ''}
        </span>
      </div>
      <div className="company-chart-controls">
        {listing && (
          <span className="quality-badge">
            {listing.name} · {listing.exchange} · {listing.currency}
          </span>
        )}
        <button
          disabled={
            busy ||
            !provider ||
            !!at ||
            !settings?.providers.find((p) => p.id === provider)?.configured
          }
          onClick={() => void refresh()}
        >
          {busy ? phase : 'Refresh price history'}
        </button>
        <button
          disabled={loading || busy}
          onClick={() => setReload((n) => n + 1)}
        >
          Reload stored history
        </button>
      </div>
      {candidates.length > 1 && (
        <div aria-label="Choose a listing" className="notice">
          <p>
            Multiple supported listings match {symbol}. Which listing do you
            mean?
          </p>
          <div className="research-actions">
            {candidates.map((c) => (
              <button
                key={c.id}
                disabled={busy}
                aria-pressed={listing?.id === c.id}
                onClick={() => {
                  setChoice(c.id);
                  if (!at) void refresh(c.id);
                }}
              >
                {c.name} · {c.exchange} · {c.currency} · {c.id}
              </button>
            ))}
          </div>
        </div>
      )}
      {resolution?.for === scope && !candidates.length && (
        <p className="notice">
          No supported US stock or ETF listing was found for {symbol}. Check the
          symbol; no exchange was guessed.
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {at && (
        <p className="muted-label">
          Historical view: only evidence stored by {marketTime(at)}. Provider
          refresh is disabled.
        </p>
      )}
      {loading && <p role="status">Loading stored price history…</p>}
      {plot && first && last ? (
        <>
          <figure className="company-chart-figure">
            <svg
              viewBox="0 0 690 244"
              role="group"
              aria-label={`${symbol} historical hourly closes`}
            >
              <Axis min={plot.min} max={plot.max} y={plot.y} />
              <polyline
                fill="none"
                className="chart-price-line"
                points={bars
                  .map((b) => `${x(b.asOf)},${plot.y(b.close)}`)
                  .join(' ')}
              />
              {bars.map((b) => (
                <circle
                  key={b.asOf}
                  cx={x(b.asOf)}
                  cy={plot.y(b.close)}
                  r={selectedBar === b ? 5 : 3}
                  className="chart-point"
                  role="button"
                  tabIndex={0}
                  aria-label={`Price ${b.asOf}: ${b.close} ${b.currency}`}
                  onFocus={() => setSelected(b.asOf)}
                  onClick={() => setSelected(b.asOf)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(b.asOf);
                    }
                  }}
                >
                  <title>
                    {marketTime(b.asOf)} · {b.close} {b.currency}
                  </title>
                </circle>
              ))}
              {events.map((d, i) => (
                <g key={d.id}>
                  <line
                    x1={x(d.published_at!)}
                    x2={x(d.published_at!)}
                    y1="28"
                    y2="210"
                    className="chart-event-line"
                  />
                  <a
                    href={`#research-document`}
                    aria-label={`Open event: ${d.title}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(d.id);
                    }}
                  >
                    <circle
                      cx={x(d.published_at!)}
                      cy={210 + (i % 2) * 12}
                      r="6"
                      className="chart-event-dot"
                    />
                    <title>
                      {d.title} · published {marketTime(d.published_at)}
                    </title>
                  </a>
                </g>
              ))}
              <text x="70" y="242">
                {day(first.asOf)}
              </text>
              <text x="660" y="242" textAnchor="end">
                {day(last.asOf)}
              </text>
            </svg>
            <figcaption>
              Hourly closes · {first.currency} · {first.exchange} ·{' '}
              {marketTime(first.asOf)} to {marketTime(last.asOf)}. Adjustment:{' '}
              {[...new Set(bars.map((b) => b.adjustment))].join(', ')}. Not a
              live quote or total-return chart.
            </figcaption>
          </figure>
          {selectedBar && (
            <div className="chart-inspection" aria-live="polite">
              <strong>
                {displayFinancialValue(selectedBar.close)}{' '}
                {selectedBar.currency}
              </strong>
              <span>
                {marketTime(selectedBar.asOf)} · {selectedBar.session} ·{' '}
                {selectedBar.quality} · delay{' '}
                {selectedBar.delayedMinutes ?? 'unknown'} min
              </span>
              <span>
                {selectedBar.entitlement} · stored{' '}
                {marketTime(record?.availableAt ?? null)}
              </span>
            </div>
          )}
        </>
      ) : (
        !loading && (
          <p className="chart-empty">
            No stored price history for this company, exchange and evidence
            cutoff. Refresh explicitly to retrieve available history from the
            selected provider.
          </p>
        )
      )}
      <p className="muted-label">
        {events.length} publication {events.length === 1 ? 'marker' : 'markers'}{' '}
        in the stored price range (up to 20). Markers show report publication
        times, not proof of what caused a price move. Undated reports are not
        plotted.
      </p>
      {events.length > 0 && (
        <details>
          <summary>Event sources</summary>
          <ul className="chart-event-sources">
            {events.map((d) => (
              <li key={d.id}>
                <button className="research-link" onClick={() => onOpen(d.id)}>
                  {d.title}
                </button>
                <small>
                  {d.provider} · published {marketTime(d.published_at)} ·
                  available {marketTime(d.available_at)}
                </small>
                <button
                  onClick={() =>
                    discuss(
                      `Explain the reported event in document ${d.id} for ${symbol}, published ${d.published_at}. Cite the saved passages. Separate event facts from any interpretation of price movement; timing alone does not establish causation.`,
                    )
                  }
                >
                  Discuss event
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
function FinancialTrend({
  symbol,
  at,
  facts,
  onOpen,
}: Pick<
  Parameters<typeof CompanyCharts>[0],
  'symbol' | 'at' | 'facts' | 'onOpen'
>) {
  const [choice, setChoice] = useState('');
  const [period, setPeriod] = useState<PeriodKind>('quarter');
  const [selected, setSelected] = useState('');
  const options = [
    ...new Map(facts.map((f) => [seriesKey(f), f])).values(),
  ].sort(
    (a, b) =>
      Number(!metricLabel(a.metric).startsWith('Revenue')) -
        Number(!metricLabel(b.metric).startsWith('Revenue')) ||
      a.metric.localeCompare(b.metric),
  );
  const key = options.some((f) => seriesKey(f) === choice)
    ? choice
    : options[0]
      ? seriesKey(options[0])
      : '';
  const { points, conflicts, omitted } = financialSeries(
    facts,
    key,
    period,
    at,
  );
  const picked = points.find((f) => f.id === selected) ?? points.at(-1);
  const plot = points.length
    ? coordinates(
        points.map((f) => f.value),
        true,
      )
    : null;
  const unit = options.find((f) => seriesKey(f) === key)?.unit;
  return (
    <article className="company-chart-card" aria-label="Financial trends">
      <div className="research-heading">
        <div>
          <span className="eyebrow">BUSINESS FUNDAMENTALS</span>
          <h2>Reported financial trends</h2>
        </div>
        <span className="quality-badge">
          {key.startsWith('fixture|') ? 'Synthetic figures' : 'Source-linked'}
        </span>
      </div>
      <div className="company-chart-controls">
        <label>
          Financial metric
          <select
            value={key}
            onChange={(e) => setChoice(e.target.value)}
            disabled={!options.length}
          >
            {!options.length && <option value="">No reported metrics</option>}
            {options.map((f) => (
              <option key={seriesKey(f)} value={seriesKey(f)}>
                {metricLabel(f.metric)} · {f.unit} · {f.provider} · {f.metric}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reporting period
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodKind)}
          >
            <option value="quarter">Quarter-length</option>
            <option value="annual">Full year</option>
            <option value="instant">Point in time</option>
          </select>
        </label>
      </div>
      {conflicts > 0 && (
        <p className="notice">
          {conflicts} conflicting periods withheld. Open financial history below
          to inspect the source observations.
        </p>
      )}
      {plot ? (
        <figure className="company-chart-figure">
          <svg
            viewBox="0 0 690 244"
            role="group"
            aria-label={`${symbol} reported financial trend`}
          >
            <Axis min={plot.min} max={plot.max} y={plot.y} />
            <line
              x1="70"
              x2="660"
              y1={plot.y(0)}
              y2={plot.y(0)}
              className="chart-grid"
            />
            {points.map((f, i) => {
              const width = 590 / points.length,
                x = 70 + width * (i + 0.5);
              return (
                <g
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Reported ${f.value} ${f.unit}, period ending ${f.period_end}`}
                  onFocus={() => setSelected(f.id)}
                  onClick={() => setSelected(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(f.id);
                    }
                  }}
                >
                  <rect
                    x={x - Math.min(width * 0.3, 34)}
                    y={Math.min(plot.y(f.value), plot.y(0))}
                    width={Math.min(width * 0.6, 68)}
                    height={Math.max(2, Math.abs(plot.y(f.value) - plot.y(0)))}
                    className={
                      picked === f ? 'chart-bar selected' : 'chart-bar'
                    }
                  />
                  <title>
                    {f.period_start ?? 'Instant'} to {f.period_end}: {f.value}{' '}
                    {f.unit}
                  </title>
                  {(points.length <= 4 ||
                    i === 0 ||
                    i === points.length - 1) && (
                    <text x={x} y="230" textAnchor="middle">
                      {f.period_end}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <figcaption>
            {unit} · {points.length} reported periods. Bar spacing is
            categorical; missing periods are not zero.{' '}
            {omitted ? `${omitted} older periods omitted. ` : ''}
            {conflicts ? `${conflicts} conflicting periods withheld. ` : ''}
          </figcaption>
        </figure>
      ) : (
        <p className="chart-empty">
          No comparable reported values for this metric and period. Import
          company financial facts or select a different reporting period.
          Missing values are not estimated.
        </p>
      )}
      {picked && (
        <div className="chart-inspection" aria-live="polite">
          <strong>
            {displayFinancialValue(picked.value)} {picked.unit}
          </strong>
          <span>
            {picked.period_start ?? 'Point in time'} → {picked.period_end} ·
            filed {picked.filed}
          </span>
          <span>
            {picked.provider} · available {marketTime(picked.available_at)}
          </span>
          <div className="research-actions">
            <button onClick={() => onOpen(picked.document_id)}>
              Open financial source
            </button>
            <button
              onClick={() =>
                discuss(
                  `Explain ${symbol}'s reported ${picked.metric}: ${picked.value} ${picked.unit}, period ${picked.period_start ?? 'instant'} to ${picked.period_end}, filed ${picked.filed}, accession ${picked.accession}, document ${picked.document_id}. Compare only matching units and reporting durations from stored evidence. Cite the source and discuss implications and risks.`,
                )
              }
            >
              Explain this figure
            </button>
          </div>
        </div>
      )}
      <p className="muted-label">
        Quarter-length means 75–105 days; full year means 330–380 days.
        Year-to-date figures are excluded, not converted into quarters. Each
        period uses its latest unambiguous filing available at the selected
        cutoff. Metrics, currencies and providers stay separate.{' '}
        {facts.length === 500
          ? 'The source result is capped at 500 observations; coverage may be incomplete.'
          : ''}{' '}
        For ETFs, these are issuer figures only, not fund valuation.
      </p>
    </article>
  );
}
