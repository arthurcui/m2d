'use client';
import { useState } from 'react';
import { instrumentKey, type State } from '@m2d/portfolio';
export type HoldingSelection = {
  accountKey: string;
  instrumentKey?: string;
  label: string;
};
export function HoldingsTable({
  state,
  account,
  selected,
  onSelect,
  onAccountChange,
}: {
  state: State;
  account: string;
  onAccountChange: (value: string) => void;
  selected: HoldingSelection | null;
  onSelect: (holding: HoldingSelection) => void;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const query = search.trim().toLowerCase();
  return (
    <div className="capital-holdings">
      <div className="holdings-controls">
        <label>
          <span className="sr-only">Account</span>
          <select
            value={account}
            onChange={(e) => onAccountChange(e.target.value)}
          >
            <option value="">All accounts</option>
            {state.accounts.map((a) => (
              <option key={a.accountKey} value={a.accountKey}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="holding-search">
          <span className="sr-only">Search holdings</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10" cy="10" r="6" />
            <path d="m15 15 5 5" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search holdings, accounts, symbols…"
          />
        </label>
      </div>
      <div className="portfolio-metrics">
        <div>
          <strong>{state.accounts.filter((a) => a.active).length}</strong>
          <span>Accounts</span>
        </div>
        <div>
          <strong>
            {state.positions.filter((p) => p.quantity !== '0').length}
          </strong>
          <span>Holdings</span>
        </div>
        <div>
          <strong>
            {[...new Set(state.cash.map((c) => c.currency))].join(' · ') || '—'}
          </strong>
          <span>Recorded currencies</span>
        </div>
      </div>
      <div className="holdings-columns" aria-hidden="true">
        <span>Account / Asset</span>
        <span>Quantity</span>
        <span>Unit cost</span>
        <span>Context</span>
      </div>
      {state.accounts
        .filter((a) => !account || account === a.accountKey)
        .map((a) => {
          const positions = state.positions.filter(
            (p) =>
              p.accountKey === a.accountKey &&
              p.quantity !== '0' &&
              (!query ||
                `${p.instrument.symbol} ${p.description ?? ''} ${a.displayName}`
                  .toLowerCase()
                  .includes(query)),
          );
          if (query && !positions.length) return null;
          const closed = collapsed.includes(a.accountKey);
          return (
            <section className="holding-account" key={a.accountKey}>
              <div className="account-heading-row">
                <button
                  className="holding-account-heading"
                  aria-expanded={!closed}
                  onClick={() =>
                    setCollapsed((old) =>
                      closed
                        ? old.filter((k) => k !== a.accountKey)
                        : [...old, a.accountKey],
                    )
                  }
                >
                  <span className="account-chevron">{closed ? '›' : '⌄'}</span>
                  <strong>
                    {a.displayName}
                    <small>{a.institution || a.accountType}</small>
                  </strong>
                  <span>{positions.length} holdings</span>
                </button>
                <button
                  className="account-context-action"
                  aria-label={`Use ${a.displayName} as Agent context`}
                  aria-pressed={
                    selected?.accountKey === a.accountKey &&
                    !selected.instrumentKey
                  }
                  onClick={() =>
                    onSelect({ accountKey: a.accountKey, label: a.displayName })
                  }
                >
                  {selected?.accountKey === a.accountKey &&
                  !selected.instrumentKey
                    ? 'Selected account'
                    : 'Ask Agent'}{' '}
                  ↗
                </button>
              </div>
              {!closed && (
                <>
                  <div className="table-scroll">
                    <table aria-label={`${a.displayName} holdings`}>
                      <thead className="sr-only">
                        <tr>
                          <th>Asset</th>
                          <th>Quantity</th>
                          <th>Unit cost</th>
                          <th>Context</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((p) => {
                          const key = instrumentKey(p.instrument);
                          const chosen =
                            selected?.accountKey === a.accountKey &&
                            selected.instrumentKey === key;
                          return (
                            <tr
                              key={key}
                              className={chosen ? 'holding-selected' : ''}
                            >
                              <th>
                                <span
                                  className="security-monogram"
                                  aria-hidden="true"
                                >
                                  {p.instrument.symbol.slice(0, 2)}
                                </span>
                                <span className="security-identity">
                                  <strong>{p.instrument.symbol}</strong>
                                  <small>
                                    {p.description || p.instrument.assetType}
                                  </small>
                                  {p.instrument.assetType === 'OPTION' && (
                                    <small>
                                      {p.instrument.optionRight}{' '}
                                      {p.instrument.strike} ·{' '}
                                      {p.instrument.expiry} · ×
                                      {p.instrument.multiplier}
                                    </small>
                                  )}
                                  {p.optionGroup && (
                                    <small>Group: {p.optionGroup}</small>
                                  )}
                                  {p.transactionDate && (
                                    <small>
                                      Transaction: {p.transactionDate}
                                    </small>
                                  )}
                                </span>
                              </th>
                              <td>{p.quantity}</td>
                              <td>
                                {p.averageCost ?? 'Unknown'}
                                <small>
                                  {p.instrument.currency} ·{' '}
                                  {p.quality.replaceAll('_', ' ').toLowerCase()}
                                </small>
                              </td>
                              <td>
                                <button
                                  className="holding-context-action"
                                  aria-pressed={chosen}
                                  aria-label={`Discuss ${p.instrument.symbol} in ${a.displayName} with Agent`}
                                  onClick={() =>
                                    onSelect({
                                      accountKey: a.accountKey,
                                      instrumentKey: key,
                                      label: `${p.instrument.symbol}${p.instrument.assetType === 'OPTION' ? ` ${p.instrument.optionRight} ${p.instrument.strike} ${p.instrument.expiry}` : ''} · ${a.displayName}`,
                                    })
                                  }
                                >
                                  {chosen ? 'Selected' : 'Ask Agent'}
                                  <span aria-hidden="true"> ↗</span>
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="account-cash">
                    {state.cash
                      .filter((c) => c.accountKey === a.accountKey)
                      .map((c) => (
                        <span key={c.currency}>
                          Cash{' '}
                          <strong>
                            {c.balance} {c.currency}
                          </strong>
                        </span>
                      ))}
                    {!positions.length && <span>No matching holdings</span>}
                  </div>
                </>
              )}
            </section>
          );
        })}
    </div>
  );
}
