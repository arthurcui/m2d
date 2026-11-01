'use client';
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { usePathname } from 'next/navigation';
import {
  isMarketSourceFailure,
  marketFailureMessage,
  type Valuation,
  type MarketSettings,
  type MarketSettingsUpdate,
} from '@m2d/market';
import { marketApi } from './market-client';
import { refreshListingDetails } from './listing-details';

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

function useMarketState() {
  const pathname = usePathname();
  const [value, setValue] = useState<ValuationView | null>(null);
  const [settings, setSettings] = useState<MarketSettings | null>(null);
  const [error, setError] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [progress, setProgress] = useState('');
  const [autoPaused, setAutoPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const stopped = useRef(false),
    inFlight = useRef(false),
    updatingSettings = useRef(false);
  const generation = useRef(0);
  const active = pathname === '/portfolio' || pathname === '/market';
  const priceAvailable =
    settings?.providers.find((p) => p.id === settings.priceProvider)
      ?.configured ?? false;
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [active, visible]);
  const load = useCallback(async () => {
    const id = ++generation.current;
    const [selection, valuation] = await Promise.all([
      marketApi<MarketSettings>('market/settings'),
      marketApi<ValuationView>('portfolio/valuation'),
    ]);
    if (id === generation.current) {
      setSettings(selection);
      // Never display an old provider's response under a newly selected source.
      setValue(
        valuation.provider === selection.priceProvider ? valuation : null,
      );
    }
    return { valuation, selection };
  }, []);
  useEffect(() => {
    const update = () => {
      void load().catch(() =>
        setError('Market data could not be loaded. Reload to retry.'),
      );
    };
    update();
    window.addEventListener('m2d-market-updated', update);
    const listingActivity = (event: Event) =>
      setListingBusy((event as CustomEvent<boolean>).detail);
    window.addEventListener('m2d-listing-refresh', listingActivity);
    const visibility = () => setVisible(document.visibilityState === 'visible');
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopped.current = true;
      generation.current++;
      window.removeEventListener('m2d-market-updated', update);
      window.removeEventListener('m2d-listing-refresh', listingActivity);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [load]);
  useEffect(() => {
    if (!active || !visible) stopped.current = true;
  }, [active, visible]);

  async function updateSettings(
    change: Omit<MarketSettingsUpdate, 'version' | 'revision'>,
  ) {
    if (!settings || updatingSettings.current) return;
    updatingSettings.current = true;
    setSavingSettings(true);
    setSettingsError('');
    stopped.current = true;
    generation.current++;
    try {
      // Analysis preferences share this settings row. Read its latest revision
      // before applying only the market fields the user explicitly changed.
      const latest = await marketApi<MarketSettings>('market/settings');
      const saved = await marketApi<MarketSettings>('market/settings', {
        version: 1,
        revision: latest.revision,
        ...change,
      });
      setSettings(saved);
      setValue(null);
      setAutoPaused(false);
      setProgress(
        change.priceProvider
          ? 'Price provider saved. Refresh to retrieve any missing prices.'
          : 'Refresh preference saved.',
      );
      await load();
      window.dispatchEvent(new Event('m2d-listings-updated'));
      window.dispatchEvent(new Event('m2d-provider-changed'));
    } catch (e) {
      setSettingsError(
        e instanceof Error ? e.message : 'The selection could not be saved.',
      );
      await load().catch(() => {});
    } finally {
      updatingSettings.current = false;
      setSavingSettings(false);
    }
  }
  function stop() {
    stopped.current = true;
    setAutoPaused(true);
  }
  async function refresh(automatic = false) {
    if (inFlight.current || updatingSettings.current || busy || listingBusy)
      return;
    inFlight.current = true;
    stopped.current = false;
    setBusy(true);
    setError('');
    const run = async () => {
      let completed = 0;
      let halted = false;
      let failedRequest = false;
      const failures: string[] = [];
      try {
        const { valuation: current, selection } = await load();
        if (
          automatic &&
          (!selection.refreshSeconds ||
            selection.refreshSeconds !== settings?.refreshSeconds ||
            selection.priceProvider !== settings.priceProvider ||
            !active ||
            !visible)
        )
          return;
        if (current.provider !== selection.priceProvider)
          throw new Error('The price provider changed. Refresh again.');
        const eligible = current.requests.filter(
          (r) =>
            (['fixture', 'ibkr'].includes(current.provider) ||
              r.kind !== 'options') &&
            (!['massive', 'ibkr'].includes(current.provider) ||
              r.kind !== 'fx'),
        );
        if (eligible.length !== current.requests.length)
          failures.push(
            ['massive', 'ibkr'].includes(current.provider)
              ? 'FX unavailable on this configuration; non-USD balances remain unconverted.'
              : 'Licensed option prices unavailable; stock and FX feeds refreshed separately.',
          );
        const requests = eligible.slice(0, 50);
        for (const [i, request] of requests.entries()) {
          if (stopped.current) break;
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
            expectedProvider: current.provider,
            request,
          });
          if (result.status !== 'SUCCEEDED') {
            failures.push(
              `${label}: ${marketFailureMessage(result.errorCode)}`,
            );
            halted = !isMarketSourceFailure(result.errorCode);
            failedRequest = true;
          } else completed++;
          await load();
          setError(failures.join(' · '));
          if (halted) break;
          if (current.refreshIntervalMs && i < requests.length - 1)
            await new Promise((r) => setTimeout(r, current.refreshIntervalMs));
        }
        if (!automatic && !stopped.current && !halted) {
          try {
            await refreshListingDetails(setProgress, () => stopped.current);
          } catch (e) {
            failures.push(
              e instanceof Error
                ? e.message
                : 'Listing details could not be refreshed.',
            );
          }
        }
        if (eligible.length > 50)
          failures.push('Refresh limited to 50 sources.');
        setError(failures.join(' · '));
        if (failedRequest) setAutoPaused(true);
        else if (!stopped.current) setAutoPaused(false);
        setProgress(
          stopped.current
            ? 'Refresh stopped. Completed sources are kept.'
            : halted
              ? `Refresh stopped after ${completed} successful sources. Completed values are kept; see the provider error below.`
              : `Refresh finished. ${completed} of ${requests.length} sources updated or loaded from cache. Missing sources remain unpriced.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Refresh failed.');
        setAutoPaused(true);
        setProgress(
          `Refresh stopped after ${completed} successful sources. Completed values are kept.`,
        );
      }
    };
    try {
      // One batch per browser origin; the server also serializes external calls.
      if (navigator.locks)
        await navigator.locks.request(
          'm2d-portfolio-prices',
          { ifAvailable: true },
          async (lock) => {
            if (lock) await run();
            else setProgress('Prices are refreshing in another tab.');
          },
        );
      else await run();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    const seconds = settings?.refreshSeconds ?? 0;
    if (
      !seconds ||
      !priceAvailable ||
      busy ||
      listingBusy ||
      savingSettings ||
      autoPaused ||
      !active ||
      !visible
    ) {
      setNextAt(null);
      return;
    }
    setNow(Date.now());
    setNextAt(Date.now() + seconds * 1000);
    const timer = setTimeout(() => {
      setNextAt(null);
      void refreshRef.current(true);
    }, seconds * 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [
    settings?.refreshSeconds,
    settings?.priceProvider,
    priceAvailable,
    busy,
    listingBusy,
    savingSettings,
    autoPaused,
    active,
    visible,
  ]);
  return {
    value,
    settings,
    error,
    settingsError,
    busy,
    listingBusy,
    savingSettings,
    progress,
    autoPaused,
    now,
    countdown:
      nextAt === null ? null : Math.max(0, Math.ceil((nextAt - now) / 1000)),
    refresh,
    stop,
    updateSettings,
    setBusy,
    setError,
    setProgress,
  };
}
const MarketContext = createContext<ReturnType<typeof useMarketState> | null>(
  null,
);
export function MarketDataProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <MarketContext.Provider value={useMarketState()}>
      {children}
    </MarketContext.Provider>
  );
}
export function useMarketData() {
  const value = useContext(MarketContext);
  if (!value) throw new Error('MarketDataProvider is required.');
  return value;
}
