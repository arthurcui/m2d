'use client';
import { useEffect, useState } from 'react';
import { systemStatusSchema, type SystemStatus } from '@m2d/domain';

const REFRESH_INTERVAL_MS = 10_000;

function time(value: string | null, timezone: string) {
  if (!value) return 'No successful run recorded';
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: timezone,
  }).format(new Date(value));
}
export function StatusPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let nextRefreshAt = 0;
    const controller = new AbortController();
    function countdown() {
      if (!active) return;
      const remaining = nextRefreshAt - Date.now();
      if (remaining <= 0) {
        void refresh();
        return;
      }
      setSecondsUntilRefresh(Math.ceil(remaining / 1000));
      timer = setTimeout(countdown, Math.min(1000, remaining));
    }
    async function refresh() {
      setSecondsUntilRefresh(null);
      try {
        const response = await fetch('/api/v1/system/status', {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
        });
        const parsed = systemStatusSchema.parse(await response.json());
        if (active) {
          setStatus(parsed);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      } finally {
        if (active) {
          nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
          countdown();
        }
      }
    }
    void refresh();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const data = status?.data;
  const unavailable = failed ? 'Unavailable' : 'Checking…';
  return (
    <section aria-label="System status" className="system">
      <div className="section-title">
        <h2>System status</h2>
        <span>
          {secondsUntilRefresh === null
            ? 'Refreshing…'
            : `Refreshes in ${secondsUntilRefresh} ${secondsUntilRefresh === 1 ? 'second' : 'seconds'}`}
        </span>
      </div>
      <div className="status-grid" aria-live="polite">
        <article>
          <p>Database</p>
          <h3>{failed ? unavailable : (data?.database ?? unavailable)}</h3>
          <small>Portfolio records and change history</small>
        </article>
        <article>
          <p>Worker</p>
          <h3>{failed ? unavailable : (data?.worker.status ?? unavailable)}</h3>
          <small>
            Heartbeat:{' '}
            {time(
              data?.worker.lastHeartbeat ?? null,
              data?.displayTimezone ?? 'America/Vancouver',
            )}
          </small>
        </article>
        <article>
          <p>Demo scheduler</p>
          <h3>
            {failed ? unavailable : (data?.worker.scheduler ?? unavailable)}
          </h3>
          <small>
            Last success:{' '}
            {time(
              data?.worker.lastDemoJob ?? null,
              data?.displayTimezone ?? 'America/Vancouver',
            )}
          </small>
        </article>
        <article>
          <p>Workbook parsing</p>
          <h3>
            {data?.ai.available
              ? 'AI ready'
              : data?.ai.status === 'fixture_only'
                ? 'Offline demo'
                : 'Setup required'}
          </h3>
          <small>
            {data
              ? `${data.ai.provider} / ${data.ai.model || 'model unset'}`
              : 'Configuration unavailable'}{' '}
            · portfolio Advisor
          </small>
        </article>
      </div>
      <p className="status-note">
        {failed
          ? 'Status refresh failed. Last recorded timestamps may be stale.'
          : status
            ? `Observed ${time(status.meta.asOf, status.data.displayTimezone)} · ${status.data.displayTimezone}`
            : 'Connecting…'}{' '}
        · Market: {data?.market.provider ?? 'unknown'} /{' '}
        {data?.market.status ?? 'unavailable'}.
      </p>
    </section>
  );
}
