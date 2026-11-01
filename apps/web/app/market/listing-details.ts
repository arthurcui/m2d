'use client';
import { isMarketSourceFailure, type ListingOverview } from '@m2d/market';
import { marketApi } from './market-client';

let refreshing = false;
export async function refreshListingDetails(
  progress: (message: string) => void,
  stopped: () => boolean,
) {
  if (refreshing) return 'Listing details are already refreshing.';
  refreshing = true;
  let completed = 0;
  try {
    const data = await marketApi<ListingOverview>('portfolio/listings');
    if (!data.configured) return '';
    const requests = data.requests.slice(0, 50);
    const failures: string[] = [];
    for (const [i, request] of requests.entries()) {
      if (stopped())
        return 'Listing refresh stopped. Completed details are kept.';
      progress(
        `Updating ${request.lookup.symbol} listing details · ${i + 1} of ${requests.length}…`,
      );
      const result = await marketApi<{
        status: string;
        errorCode: string | null;
      }>('market/refresh', {
        version: 1,
        idempotencyKey: crypto.randomUUID(),
        request,
      });
      if (result.status === 'SUCCEEDED') completed++;
      else {
        failures.push(
          `${request.lookup.symbol}: listing details unavailable (${result.errorCode ?? 'UNKNOWN_ERROR'}).`,
        );
        if (!isMarketSourceFailure(result.errorCode)) break;
      }
      window.dispatchEvent(new Event('m2d-listings-updated'));
    }
    const ending =
      data.requests.length > 50
        ? ' Refresh again for the remaining listings.'
        : '';
    if (failures.length) throw new Error(failures.join(' '));
    return requests.length
      ? `${completed} listings updated.${ending}`
      : 'Listing details are up to date.';
  } finally {
    window.dispatchEvent(new Event('m2d-listings-updated'));
    refreshing = false;
  }
}
