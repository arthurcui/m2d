'use client';
import { qualityAt, type Valuation } from '@m2d/market';
import { marketTime } from '../market/market-client';

export function HoldingMarketPrice({
  position,
  currency,
  now,
}: {
  position: Valuation['positions'][number] | undefined;
  currency: string;
  now: number;
}) {
  const quote = position?.quote;
  if (!quote || position?.mark == null)
    return (
      <td className="holding-market-price">
        <span>—</span>
        <small>{currency} · Unavailable</small>
      </td>
    );
  const daily = quote.kind === 'EOD_CLOSE';
  const freshness = qualityAt(quote, new Date(now).toISOString()).freshness;
  return (
    <td className="holding-market-price">
      <span className="market-mark">
        {position.mark} <span className="price-currency">{currency}</span>
      </span>
      <details className="holding-price-evidence">
        <summary>
          {quote.provider === 'ibkr'
            ? 'IBKR'
            : quote.provider === 'fixture'
              ? 'Synthetic'
              : quote.provider === 'massive'
                ? 'Massive'
                : 'Twelve Data'}{' '}
          ·{' '}
          {daily
            ? 'EOD close'
            : quote.quality === 'DELAYED'
              ? 'Delayed'
              : quote.quality === 'UNKNOWN'
                ? 'Indicative'
                : freshness === 'STALE'
                  ? 'Stale'
                  : 'Snapshot'}
        </summary>
        <div>
          <p>
            {daily ? 'Daily period ending' : 'As of'}: {marketTime(quote.asOf)}
          </p>
          <p>
            Source: {quote.provider} · Session: {quote.session} · Quality:{' '}
            {quote.quality} · Freshness: {freshness}
          </p>
          <p>
            Delay:{' '}
            {quote.delayedMinutes === null
              ? 'unknown'
              : `${quote.delayedMinutes} minutes`}{' '}
            ·{' '}
            {position.markPolicy === 'MIDPOINT'
              ? 'Bid/ask midpoint'
              : 'Last trade or close'}
          </p>
          <p>
            Indicative value; recorded unit cost and trade prices are unchanged.
          </p>
        </div>
      </details>
      <small className="price-asof">{marketTime(quote.asOf)}</small>
    </td>
  );
}
