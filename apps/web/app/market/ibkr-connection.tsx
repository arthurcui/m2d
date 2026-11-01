'use client';
import { useEffect, useState } from 'react';
import { marketApi } from './valuation';
type Status = {
  connected: boolean;
  pending: boolean;
  active: boolean;
  available: boolean;
  scope: string;
  expiresAt: string | null;
};
export function IbkrConnectionPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () =>
    setStatus(await marketApi<Status>('market/ibkr/status'));
  useEffect(() => {
    void load().catch(() => setError('IBKR connection status unavailable.'));
    const url = new URL(window.location.href);
    if (url.searchParams.get('ibkr') === 'connected')
      setNotice('IBKR authorization saved.');
    if (url.searchParams.get('ibkr') === 'failed')
      setError(
        'IBKR authorization was cancelled, expired or could not be verified. Try Connect IBKR again.',
      );
    if (url.searchParams.has('ibkr')) {
      url.searchParams.delete('ibkr');
      window.history.replaceState(null, '', url);
    }
  }, []);
  async function connect() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/ibkr/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await response.json()) as {
        authorizationUrl?: string;
        error?: { message: string };
      };
      if (!response.ok || !body.authorizationUrl)
        throw new Error(
          body.error?.message ?? 'Could not start the IBKR connection.',
        );
      const url = new URL(body.authorizationUrl);
      if (
        url.origin !== 'https://api.ibkr.com' ||
        url.pathname !== '/oauth2/authorize'
      )
        throw new Error('Unexpected IBKR authorization destination.');
      window.location.assign(url.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await marketApi('market/ibkr/disconnect', {});
      await load();
      setNotice(
        'Local IBKR authorization removed. You can also revoke the app consent in IBKR Client Portal.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card" aria-label="IBKR connection">
      <div className="card-heading">
        <h2>Interactive Brokers</h2>
        <span className="badge">
          {status?.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <p>
        Connect directly to IBKR for market data. Sign in and grant read access
        on IBKR’s website.
      </p>
      <p className="card-note">
        M²D uses stock, ETF and option market tools only. Your recorded
        portfolio remains self-reported. Data availability and delay depend on
        your IBKR subscriptions.
      </p>
      {status?.connected && (
        <p>
          {status.active
            ? 'IBKR is the selected market provider.'
            : 'IBKR is connected. To use it for prices, set MARKET_PROVIDER=ibkr in the backend .env and recreate the app containers.'}
        </p>
      )}
      <div className="market-actions">
        <button
          disabled={busy || !status?.available}
          onClick={() => void connect()}
        >
          {busy
            ? 'Connecting…'
            : status?.connected
              ? 'Reconnect IBKR'
              : 'Connect IBKR'}
        </button>
        {(status?.connected || status?.pending) && (
          <button disabled={busy} onClick={() => void disconnect()}>
            Disconnect IBKR
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </section>
  );
}
