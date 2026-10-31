'use client';
import { useState } from 'react';
import {
  importFields,
  type WorkbookInspection,
  type WorkbookMapping,
  type ImportTable,
  type ImportField,
  type WorkbookSheet,
} from '@m2d/portfolio';
type RowError = { sheet: string; row: number; field: string; message: string };
const labels: Partial<Record<ImportField, string>> = {
  AccountKey: 'Account',
  DisplayName: 'Account display name',
  BaseCurrency: 'Account base currency',
  AverageCost: 'Average cost / quote unit',
  TotalCost: 'Total book cost',
  Balance: 'Cash balance',
  AssetType: 'Security type',
  OptionRight: 'Call / put',
  Expiration: 'Option expiration',
};
const basic: ImportField[] = [
  'AccountKey',
  'Symbol',
  'Quantity',
  'AverageCost',
  'TotalCost',
  'Balance',
  'Currency',
  'Exchange',
  'AssetType',
  'BaseCurrency',
];
function SourceRows({
  sheet,
  mapping,
  change,
}: {
  sheet: WorkbookSheet;
  mapping: WorkbookMapping;
  change: (fn: (next: WorkbookMapping) => void) => void;
}) {
  const [page, setPage] = useState(0),
    [editing, setEditing] = useState<number | null>(null);
  const count = Math.ceil(sheet.rows.length / 25);
  const edit = (
    row: number,
    fn: (o: WorkbookMapping['overrides'][number]) => void,
  ) =>
    change((m) => {
      let o = m.overrides.find((x) => x.sheet === sheet.name && x.row === row);
      if (!o) {
        o = { sheet: sheet.name, row, reason: '', values: {} };
        m.overrides.push(o);
      }
      fn(o);
    });
  return (
    <details>
      <summary>
        Source rows, exclusions, and individual corrections ({sheet.rows.length}{' '}
        rows)
      </summary>
      <p>
        Exclude subtotal, heading, or unrelated rows explicitly. Corrections are
        saved with a reason; the original file remains unchanged.
      </p>
      <div className="toolbar">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous rows
        </button>
        <span>
          Page {page + 1} of {Math.max(1, count)}
        </span>
        <button
          type="button"
          disabled={page >= count - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          Next rows
        </button>
      </div>
      <div className="table-scroll" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Source values (column: value)</th>
              <th>Exclude / reason</th>
              <th>Correct individual fields</th>
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(page * 25, page * 25 + 25).map((cells, index) => {
              const row = page * 25 + index + 1,
                excluded = mapping.excludedRows.find(
                  (e) => e.sheet === sheet.name && e.row === row,
                ),
                override = mapping.overrides.find(
                  (e) => e.sheet === sheet.name && e.row === row,
                );
              return (
                <tr key={row}>
                  <th>{row}</th>
                  <td>
                    {cells.map((v, c) =>
                      v ? (
                        <div key={c}>
                          <strong>{c + 1}:</strong> {v}
                        </div>
                      ) : null,
                    )}
                  </td>
                  <td>
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`Exclude ${sheet.name} row ${row}`}
                        checked={!!excluded}
                        onChange={(e) =>
                          change((m) => {
                            m.excludedRows = m.excludedRows.filter(
                              (x) => x.sheet !== sheet.name || x.row !== row,
                            );
                            if (e.target.checked)
                              m.excludedRows.push({
                                sheet: sheet.name,
                                row,
                                reason: '',
                              });
                          })
                        }
                      />
                      Exclude
                    </label>
                    {excluded && (
                      <input
                        aria-label={`Exclusion reason ${sheet.name} row ${row}`}
                        value={excluded.reason}
                        placeholder="Required reason"
                        onChange={(e) =>
                          change((m) => {
                            m.excludedRows.find(
                              (x) => x.sheet === sheet.name && x.row === row,
                            )!.reason = e.target.value;
                          })
                        }
                      />
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setEditing(editing === row ? null : row)}
                    >
                      {editing === row
                        ? 'Close correction'
                        : override
                          ? 'Edit correction'
                          : 'Correct fields'}
                    </button>
                    {editing === row && (
                      <div>
                        <label>
                          Correction reason
                          <input
                            value={override?.reason ?? ''}
                            onChange={(e) =>
                              edit(row, (o) => {
                                o.reason = e.target.value;
                              })
                            }
                          />
                        </label>
                        {importFields.map((field) => (
                          <label key={field}>
                            {labels[field] ?? field}
                            <input
                              value={override?.values[field] ?? ''}
                              placeholder="Use mapping"
                              onChange={(e) =>
                                edit(row, (o) => {
                                  if (e.target.value === '')
                                    delete o.values[field];
                                  else o.values[field] = e.target.value;
                                })
                              }
                            />
                          </label>
                        ))}
                        {override && (
                          <button
                            type="button"
                            onClick={() =>
                              change((m) => {
                                m.overrides = m.overrides.filter(
                                  (x) =>
                                    x.sheet !== sheet.name || x.row !== row,
                                );
                              })
                            }
                          >
                            Remove correction
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
export function ImportReview({
  error,
  inspection,
  busy,
  errors,
  onSubmit,
  onCancel,
}: {
  error: string;
  inspection: WorkbookInspection;
  busy: boolean;
  errors: RowError[];
  onSubmit: (mapping: WorkbookMapping) => void;
  onCancel: () => void;
}) {
  const [mapping, setMapping] = useState<WorkbookMapping>(inspection.mapping),
    [reviewed, setReviewed] = useState(false);
  const change = (fn: (next: WorkbookMapping) => void) => {
    setMapping((old) => {
      const next = structuredClone(old);
      fn(next);
      return next;
    });
    setReviewed(false);
  };
  const tableChange = (index: number, fn: (table: ImportTable) => void) =>
    change((next) => fn(next.tables[index]!));
  const fields = (index: number, list: readonly ImportField[]) => {
    const table = mapping.tables[index]!,
      sheet = inspection.sheets.find((s) => s.name === table.sheet)!;
    const header = sheet.rows[table.headerRow - 1] ?? [];
    const count = Math.max(
      header.length,
      ...sheet.rows
        .slice(table.firstRow - 1, table.lastRow)
        .map((r) => r.length),
    );
    return (
      <div className="table-scroll" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Portfolio field</th>
              <th>Workbook column</th>
              <th>Value when no column is mapped</th>
            </tr>
          </thead>
          <tbody>
            {list.map((field) => (
              <tr key={field}>
                <th>{labels[field] ?? field}</th>
                <td>
                  <select
                    aria-label={`${table.sheet} table ${index + 1} ${field} column`}
                    value={table.columns[field] ?? ''}
                    onChange={(e) =>
                      tableChange(index, (t) => {
                        if (e.target.value === '') delete t.columns[field];
                        else t.columns[field] = Number(e.target.value);
                      })
                    }
                  >
                    <option value="">Not mapped</option>
                    {Array.from({ length: count }, (_, c) => (
                      <option key={c} value={c}>
                        {c + 1}: {header[c] || '(unnamed)'}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`${table.sheet} table ${index + 1} ${field} default`}
                    value={table.defaults[field] ?? ''}
                    disabled={table.columns[field] !== undefined}
                    placeholder={
                      field === 'AssetType'
                        ? 'STOCK / ETF / OPTION'
                        : field === 'Currency' || field === 'BaseCurrency'
                          ? 'USD / CAD'
                          : field === 'Deliverable'
                            ? 'STANDARD'
                            : field === 'Multiplier'
                              ? '100 for standard options'
                              : ''
                    }
                    onChange={(e) =>
                      tableChange(index, (t) => {
                        if (e.target.value === '') delete t.defaults[field];
                        else t.defaults[field] = e.target.value;
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <section
      className="workspace-card import-review"
      aria-label="Workbook interpretation"
    >
      <div className="card-heading">
        <h2>Review workbook interpretation</h2>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <span className="badge">
          {inspection.sheets.length} tabs · No holdings changed
        </span>
      </div>
      <div className="form-body">
        <p>
          We detected the tables below. Verify the columns, account identities,
          default values, and row exclusions. Fill missing details here; you do
          not need to rearrange your workbook.
        </p>
        {inspection.warnings.map((w) => (
          <p className="notice" key={w}>
            {w}
          </p>
        ))}
        {errors.length > 0 && (
          <div role="alert" className="notice error">
            <strong>Resolve these rows before continuing</strong>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>
                  {e.sheet} · row {e.row || '—'} · {e.field}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset disabled={busy}>
          {inspection.sheets.map((sheet) => (
            <section
              className="import-sheet"
              key={sheet.name}
              aria-label={`Sheet ${sheet.name}`}
            >
              <div className="toolbar">
                <h3>{sheet.name}</h3>
                <span>{sheet.rows.length} rows</span>
              </div>
              {mapping.tables.map((t, index) =>
                t.sheet !== sheet.name ? null : (
                  <div className="import-table" key={index}>
                    <h4>Table {index + 1}</h4>
                    <div className="form-grid">
                      <label>
                        Table contains
                        <select
                          value={t.kind}
                          onChange={(e) =>
                            tableChange(index, (x) => {
                              x.kind = e.target.value as ImportTable['kind'];
                            })
                          }
                        >
                          <option value="unresolved">Choose table type</option>
                          <option value="mixed">Positions and cash rows</option>
                          <option value="positions">Positions only</option>
                          <option value="cash">Cash balances only</option>
                          <option value="accounts">Account definitions</option>
                        </select>
                      </label>
                      {(['headerRow', 'firstRow', 'lastRow'] as const).map(
                        (field) => (
                          <label key={field}>
                            {field === 'headerRow'
                              ? 'Header row'
                              : field === 'firstRow'
                                ? 'First data row'
                                : 'Last data row'}
                            <input
                              type="number"
                              min={field === 'headerRow' ? 0 : 1}
                              max={sheet.rows.length}
                              value={t[field]}
                              onChange={(e) =>
                                tableChange(index, (x) => {
                                  x[field] = Number(e.target.value);
                                })
                              }
                            />
                          </label>
                        ),
                      )}
                    </div>
                    {fields(
                      index,
                      t.kind === 'accounts'
                        ? [
                            'AccountKey',
                            'DisplayName',
                            'Institution',
                            'AccountType',
                            'BaseCurrency',
                            'Active',
                            'Notes',
                          ]
                        : basic,
                    )}
                    <details>
                      <summary>
                        Option terms and additional account fields
                      </summary>
                      {fields(
                        index,
                        importFields.filter(
                          (f) =>
                            !(
                              t.kind === 'accounts'
                                ? [
                                    'AccountKey',
                                    'DisplayName',
                                    'Institution',
                                    'AccountType',
                                    'BaseCurrency',
                                    'Active',
                                    'Notes',
                                  ]
                                : basic
                            ).includes(f),
                        ),
                      )}
                    </details>
                    <button
                      type="button"
                      onClick={() =>
                        change((m) => {
                          m.tables.splice(index, 1);
                        })
                      }
                    >
                      Remove this table mapping
                    </button>
                  </div>
                ),
              )}
              <div className="toolbar">
                <button
                  type="button"
                  onClick={() =>
                    change((m) =>
                      m.tables.push({
                        sheet: sheet.name,
                        headerRow: 1,
                        firstRow: 2,
                        lastRow: sheet.rows.length,
                        kind: 'unresolved',
                        columns: {},
                        defaults: {},
                      }),
                    )
                  }
                >
                  Add another table
                </button>
                <button
                  type="button"
                  onClick={() =>
                    change((m) => {
                      m.tables = m.tables.filter((t) => t.sheet !== sheet.name);
                      m.excludedRows = m.excludedRows.filter(
                        (e) => e.sheet !== sheet.name,
                      );
                      sheet.rows.forEach((r, i) => {
                        if (r.some((v) => v.trim()))
                          m.excludedRows.push({
                            sheet: sheet.name,
                            row: i + 1,
                            reason:
                              'User excluded this entire tab as unrelated to portfolio state',
                          });
                      });
                    })
                  }
                >
                  Exclude this entire tab
                </button>
                <button
                  type="button"
                  onClick={() =>
                    change((m) => {
                      m.tables = m.tables
                        .filter((t) => t.sheet !== sheet.name)
                        .concat(
                          structuredClone(
                            inspection.mapping.tables.filter(
                              (t) => t.sheet === sheet.name,
                            ),
                          ),
                        );
                      m.excludedRows = m.excludedRows
                        .filter((e) => e.sheet !== sheet.name)
                        .concat(
                          structuredClone(
                            inspection.mapping.excludedRows.filter(
                              (e) => e.sheet === sheet.name,
                            ),
                          ),
                        );
                    })
                  }
                >
                  Restore detected mappings
                </button>
              </div>
              <SourceRows sheet={sheet} mapping={mapping} change={change} />
            </section>
          ))}
          <h3>Cash balances missing from the file</h3>
          <p>
            If an account has no cash row, enter its verified balance here,
            including zero. These values are recorded as your clarification, not
            as workbook data.
          </p>
          {mapping.cashBalances.map((c, index) => (
            <div className="form-grid" key={index}>
              <label>
                Account key or name
                <input
                  value={c.account}
                  onChange={(e) =>
                    change((m) => {
                      m.cashBalances[index]!.account = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Currency
                <select
                  value={c.currency}
                  onChange={(e) =>
                    change((m) => {
                      m.cashBalances[index]!.currency = e.target.value as
                        'USD' | 'CAD';
                    })
                  }
                >
                  <option>USD</option>
                  <option>CAD</option>
                </select>
              </label>
              <label>
                Verified cash balance
                <input
                  value={c.balance}
                  onChange={(e) =>
                    change((m) => {
                      m.cashBalances[index]!.balance = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Source / reason
                <input
                  value={c.reason}
                  onChange={(e) =>
                    change((m) => {
                      m.cashBalances[index]!.reason = e.target.value;
                    })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  change((m) => {
                    m.cashBalances.splice(index, 1);
                  })
                }
              >
                Remove cash clarification
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              change((m) =>
                m.cashBalances.push({
                  account: '',
                  currency: 'USD',
                  balance: '',
                  reason: '',
                }),
              )
            }
          >
            Add missing cash balance
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I reviewed every tab, column mapping, default, and excluded row,
            including any saved formula values.
          </label>
          <div className="toolbar">
            <button
              className="primary"
              disabled={!reviewed}
              onClick={() => onSubmit(mapping)}
            >
              Create replacement preview
            </button>
            <button onClick={onCancel}>Cancel interpretation</button>
          </div>
        </fieldset>
      </div>
    </section>
  );
}
