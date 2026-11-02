'use client';
import { useRef, useState } from 'react';
import { researchRequest } from './import-feedback';

export function CompanyPicker({
  companies,
  portfolioSymbols,
  choices,
  selected,
  disabled,
  onSelect,
  onChoicesChange,
}: {
  companies: { symbol: string; name: string }[];
  portfolioSymbols: string[];
  choices: { symbol: string; hidden: boolean }[];
  selected: string;
  disabled: boolean;
  onSelect: (symbol: string) => void;
  onChoicesChange: () => Promise<void>;
}) {
  const [input, setInput] = useState(''),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const locked = useRef(false);
  const hidden = new Set(choices.filter((c) => c.hidden).map((c) => c.symbol));
  const symbols = [
    ...new Set([
      ...portfolioSymbols,
      ...companies.map((c) => c.symbol),
      ...choices.map((c) => c.symbol),
    ]),
  ]
    .filter((s) => !hidden.has(s))
    .sort();
  const name = (symbol: string) =>
    companies.find((c) => c.symbol === symbol)?.name ?? symbol;
  const query = input.trim().toLowerCase();
  const matches = symbols.filter(
    (s) =>
      s.toLowerCase().includes(query) || name(s).toLowerCase().includes(query),
  );
  const exact = symbols.find(
    (s) => s.toLowerCase() === query || name(s).toLowerCase() === query,
  );
  const target =
    exact ??
    (/^[A-Z0-9.-]{1,24}$/i.test(input.trim())
      ? input.trim().toUpperCase()
      : '');
  async function choose(symbol: string, hide: boolean) {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await researchRequest('/companies/selection', {
        version: 1,
        symbol,
        hidden: hide,
      });
      await onChoicesChange();
      if (hide) {
        if (selected === symbol) onSelect('');
        setMessage(
          `${symbol} removed from suggestions. Its documents and holdings are kept.`,
        );
      } else {
        onSelect(symbol);
        setInput('');
        setOpen(false);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not save company selection.',
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="company-picker">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (target) void choose(target, false);
        }}
      >
        <label>
          Company name or underlying ticker
          <input
            aria-label="Research ticker"
            type="search"
            value={input}
            maxLength={150}
            autoComplete="off"
            placeholder="Find a saved company or add a ticker"
            disabled={disabled || busy}
            aria-describedby="company-selection-help"
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setInput(e.target.value);
              setOpen(true);
              setMessage('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
                e.preventDefault();
              }
            }}
          />
        </label>
        <button disabled={!target || disabled || busy}>
          {exact
            ? `Select ${target}`
            : target
              ? `Add ${target}`
              : 'Select company'}
        </button>
      </form>
      <small id="company-selection-help">
        Select a suggestion or press Enter to use a ticker. Typing does not
        change your research context.
      </small>
      {open && (
        <div
          className="company-suggestions"
          aria-label="Saved company suggestions"
        >
          <ul>
            {matches.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  disabled={disabled || busy}
                  aria-label={`Select ${s}`}
                  onClick={() => void choose(s, false)}
                >
                  <strong>{s}</strong>
                  {name(s) !== s && <span>{name(s)}</span>}
                </button>
                <button
                  type="button"
                  className="company-remove"
                  aria-label={`Remove ${s} from suggestions`}
                  disabled={disabled || busy}
                  onClick={() => void choose(s, true)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {!matches.length && (
            <p>No saved matches. Enter a ticker to add it.</p>
          )}
          <button type="button" onClick={() => setOpen(false)}>
            Close suggestions
          </button>
        </div>
      )}
      {selected && (
        <div className="selected-company">
          <span>
            Selected company: <strong>{selected}</strong>
            {name(selected) !== selected ? ` · ${name(selected)}` : ''}
          </span>
          <button
            type="button"
            disabled={disabled || busy}
            aria-label="Clear selected company"
            onClick={() => onSelect('')}
          >
            ×
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </div>
  );
}
