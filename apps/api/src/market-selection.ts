import type { MarketRepository } from '@m2d/db';
import {
  MarketError,
  priceProviderSchema,
  listingProviderSchema,
  marketSettingsUpdateSchema,
  type MarketProvider,
  type MarketSettings,
} from '@m2d/market';

export function createMarketSelection(
  repository: Pick<MarketRepository, 'settings' | 'updateSettings'>,
  providers: Record<MarketSettings['priceProvider'], MarketProvider>,
  defaults: Pick<MarketSettings, 'priceProvider' | 'listingProvider'>,
) {
  async function settings(): Promise<MarketSettings> {
    const saved = await repository.settings();
    return {
      revision: saved.revision,
      priceProvider: priceProviderSchema.parse(
        saved.marketProvider ?? defaults.priceProvider,
      ),
      listingProvider: listingProviderSchema.parse(
        saved.listingProvider ?? defaults.listingProvider,
      ),
      refreshSeconds: saved.priceRefreshSeconds,
      providers: [
        {
          id: 'ibkr',
          label: 'IBKR',
          minimumRefreshSeconds: 15,
          priceDescription:
            'Prices depend on your market-data subscriptions. Frozen or unknown data remains indicative.',
          listingDescription:
            'Provider descriptions can be abbreviated. Logos are unavailable.',
        },
        {
          id: 'massive',
          label: 'Massive Basic',
          minimumRefreshSeconds: 60,
          priceDescription:
            'End-of-day prices. Faster refresh does not provide live quotes; completed-day results are cached.',
          listingDescription:
            'Full listing names and available company or fund logos.',
        },
        {
          id: 'twelvedata',
          label: 'Twelve Data',
          minimumRefreshSeconds: 60,
          priceDescription:
            'Stock and ETF prices depend on your plan. Options are unavailable.',
          listingDescription:
            'Listing details are unavailable in this adapter.',
        },
        {
          id: 'fixture',
          label: 'Offline fixtures',
          minimumRefreshSeconds: 15,
          priceDescription: 'Synthetic examples, not actual market prices.',
          listingDescription:
            'Synthetic names and demo icons, not actual company logos.',
        },
      ].map((p) => ({
        ...p,
        id: priceProviderSchema.parse(p.id),
        configured: providers[priceProviderSchema.parse(p.id)].configured,
        listings:
          typeof providers[priceProviderSchema.parse(p.id)].fetchListing ===
          'function',
      })),
    };
  }
  return {
    settings,
    async current() {
      const selected = await settings();
      return {
        price: providers[selected.priceProvider],
        listing:
          selected.listingProvider === 'none'
            ? undefined
            : providers[selected.listingProvider],
      };
    },
    async update(body: unknown) {
      const input = marketSettingsUpdateSchema.parse(body);
      const current = await settings();
      const priceProvider = input.priceProvider ?? current.priceProvider;
      const listingProvider = input.listingProvider ?? current.listingProvider;
      const refreshSeconds =
        input.refreshSeconds ??
        (priceProvider !== current.priceProvider ? 0 : current.refreshSeconds);
      if (input.priceProvider && !providers[priceProvider].configured)
        throw new MarketError(
          'MARKET_NOT_CONFIGURED',
          'Connect or configure this price provider first.',
          409,
        );
      if (
        input.listingProvider &&
        listingProvider !== 'none' &&
        (!providers[listingProvider].configured ||
          !providers[listingProvider].fetchListing)
      )
        throw new MarketError(
          'MARKET_NOT_CONFIGURED',
          'Connect or configure this listing provider first.',
          409,
        );
      const price = current.providers.find((p) => p.id === priceProvider)!;
      if (
        refreshSeconds &&
        (!price.configured || refreshSeconds < price.minimumRefreshSeconds)
      )
        throw new MarketError(
          'INVALID_REFRESH_INTERVAL',
          `This provider requires at least ${price.minimumRefreshSeconds} seconds between completed refresh batches.`,
          400,
        );
      await repository.updateSettings(input.revision, {
        marketProvider: priceProvider,
        listingProvider,
        priceRefreshSeconds: refreshSeconds,
      });
      return settings();
    },
  };
}
export type MarketSelection = ReturnType<typeof createMarketSelection>;
