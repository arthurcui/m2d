'use client';
import { priceProviderSchema, listingProviderSchema } from '@m2d/market';
import { useMarketData } from './market-context';

export function MarketControls() {
  const {
    settings,
    settingsError,
    savingSettings,
    updateSettings,
    value,
    busy,
    listingBusy,
    refresh,
    stop,
    countdown,
    autoPaused,
    progress,
    error,
  } = useMarketData();
  const price = settings?.providers.find(
    (p) => p.id === settings.priceProvider,
  );
  const listing = settings?.providers.find(
    (p) => p.id === settings.listingProvider,
  );
  return (
    <section
      className="portfolio-price-controls"
      aria-label="Portfolio price settings"
    >
      <div className="price-control-fields">
        <label>
          Price provider
          <select
            value={settings?.priceProvider ?? ''}
            disabled={!settings || savingSettings}
            onChange={(e) =>
              void updateSettings({
                priceProvider: priceProviderSchema.parse(e.target.value),
              })
            }
          >
            {!settings && <option value="">Loading providers…</option>}
            {settings?.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.label}
                {p.configured
                  ? ''
                  : p.id === 'ibkr'
                    ? ' · connect first'
                    : ' · key required'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Listing details provider
          <select
            value={settings?.listingProvider ?? 'none'}
            disabled={!settings || savingSettings}
            onChange={(e) =>
              void updateSettings({
                listingProvider: listingProviderSchema.parse(e.target.value),
              })
            }
          >
            <option value="none">None</option>
            {settings?.providers
              .filter((p) => p.listings)
              .map((p) => (
                <option key={p.id} value={p.id} disabled={!p.configured}>
                  {p.label}
                  {p.configured
                    ? ''
                    : p.id === 'ibkr'
                      ? ' · connect first'
                      : ' · key required'}
                </option>
              ))}
          </select>
        </label>
        <label>
          Price refresh
          <select
            value={settings?.refreshSeconds ?? 0}
            disabled={!settings || savingSettings || !price?.configured}
            onChange={(e) =>
              void updateSettings({ refreshSeconds: Number(e.target.value) })
            }
          >
            <option value="0">Manual</option>
            {[
              ...new Set([
                15,
                30,
                60,
                120,
                300,
                900,
                ...(settings?.refreshSeconds ? [settings.refreshSeconds] : []),
              ]),
            ]
              .sort((a, b) => a - b)
              .map((seconds) => (
                <option
                  key={seconds}
                  value={seconds}
                  disabled={seconds < (price?.minimumRefreshSeconds ?? 15)}
                >
                  Every {seconds} seconds
                </option>
              ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={
            busy ||
            listingBusy ||
            savingSettings ||
            !value ||
            !price?.configured
          }
          onClick={() => void refresh()}
        >
          Refresh prices now
        </button>
        {busy && <button onClick={stop}>Stop refresh</button>}
      </div>
      <div className="price-source-notes">
        <span>{price?.priceDescription}</span>
        {listing && <span>Listing details: {listing.listingDescription}</span>}
        <span>
          {savingSettings
            ? 'Saving…'
            : countdown !== null
              ? `Refreshes in ${countdown} ${countdown === 1 ? 'second' : 'seconds'}`
              : busy
                ? 'Processing price refresh…'
                : settings?.refreshSeconds
                  ? autoPaused
                    ? 'Auto-refresh paused. Refresh manually to retry.'
                    : 'Auto-refresh resumes while Portfolio or Market is visible.'
                  : 'Manual refresh · selections save automatically'}
        </span>
      </div>
      {settingsError && (
        <p className="notice" role="alert">
          {settingsError}
        </p>
      )}
      {progress && (
        <p className="listing-feedback" role="status">
          {progress}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
