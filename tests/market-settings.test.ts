import { it, expect } from 'vitest';
import { createMarketSelection } from '../apps/api/src/market-selection.js';
import {
  marketSettingsUpdateSchema,
  MarketError,
  type MarketProvider,
} from '../packages/market/src/index.js';
import type { MarketRepository } from '../packages/db/src/index.js';

function setup() {
  let row: Awaited<ReturnType<MarketRepository['settings']>> = {
    id: 1,
    revision: 0,
    defaultAnalysisMode: 'extensive',
    marketProvider: null,
    listingProvider: null,
    priceRefreshSeconds: 0,
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Settings must never fetch data.');
  };
  const make = (
    id: MarketProvider['id'],
    configured = true,
  ): MarketProvider => ({
    id,
    configured,
    quote: unsupported,
    bars: unsupported,
    fx: unsupported,
    options: unsupported,
    ...(id !== 'twelvedata' ? { fetchListing: unsupported } : {}),
  });
  const providers = {
    fixture: make('fixture'),
    massive: make('massive'),
    ibkr: make('ibkr', false),
    twelvedata: make('twelvedata', false),
  };
  const repository: Pick<MarketRepository, 'settings' | 'updateSettings'> = {
    settings: async () => row,
    updateSettings: async (revision, values) => {
      if (revision !== row.revision)
        throw new MarketError('SETTINGS_CONFLICT', 'Conflict', 409);
      row = { ...row, ...values, revision: revision + 1 };
      return row;
    },
  };
  const defaults = {
    priceProvider: 'fixture' as const,
    listingProvider: 'massive' as const,
  };
  return {
    selection: createMarketSelection(repository, providers, defaults),
    repository,
    providers,
    defaults,
  };
}
it('persists separate choices and reloads them over environment defaults without provider calls', async () => {
  const { selection, repository, providers, defaults } = setup();
  expect(await selection.settings()).toMatchObject({
    priceProvider: 'fixture',
    listingProvider: 'massive',
    refreshSeconds: 0,
  });
  await selection.update({ version: 1, revision: 0, refreshSeconds: 30 });
  const changed = await selection.update({
    version: 1,
    revision: 1,
    priceProvider: 'massive',
  });
  expect(changed).toMatchObject({
    priceProvider: 'massive',
    listingProvider: 'massive',
    refreshSeconds: 0,
    revision: 2,
  });
  await selection.update({
    version: 1,
    revision: 2,
    listingProvider: 'none',
    refreshSeconds: 60,
  });
  expect(
    await createMarketSelection(repository, providers, defaults).settings(),
  ).toMatchObject({
    priceProvider: 'massive',
    listingProvider: 'none',
    refreshSeconds: 60,
  });
  expect((await repository.settings()).defaultAnalysisMode).toBe('extensive');
  expect((await selection.current()).listing).toBeUndefined();
});
it('rejects unavailable sources, invalid intervals and stale preference writes', async () => {
  const { selection } = setup();
  await expect(
    selection.update({ version: 1, revision: 0, priceProvider: 'ibkr' }),
  ).rejects.toMatchObject({ code: 'MARKET_NOT_CONFIGURED' });
  await expect(
    selection.update({ version: 1, revision: 0, listingProvider: 'ibkr' }),
  ).rejects.toMatchObject({ code: 'MARKET_NOT_CONFIGURED' });
  await expect(
    selection.update({
      version: 1,
      revision: 0,
      priceProvider: 'massive',
      refreshSeconds: 15,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REFRESH_INTERVAL' });
  await selection.update({ version: 1, revision: 0, refreshSeconds: 15 });
  await expect(
    selection.update({ version: 1, revision: 0, listingProvider: 'none' }),
  ).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' });
  for (const refreshSeconds of [-1, 1, 14, 15.5, 3601])
    expect(
      marketSettingsUpdateSchema.safeParse({
        version: 1,
        revision: 1,
        refreshSeconds,
      }).success,
    ).toBe(false);
  expect(
    marketSettingsUpdateSchema.safeParse({
      version: 1,
      revision: 1,
      listingProvider: 'twelvedata',
    }).success,
  ).toBe(false);
});
