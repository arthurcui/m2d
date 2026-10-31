import { describe, it, expect } from 'vitest';
import {
  applyOperation,
  operationSchema,
  stateSchema,
  emptyState,
  instrumentSchema,
  instrumentKey,
  signedMarketValue,
  replacement,
  warnings,
} from '../packages/portfolio/src/index.js';
import {
  parseWorkbook,
  workbook,
  sevenAccountFixture,
} from '../packages/ingestion/src/index.js';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
const stock = instrumentSchema.parse({
  assetType: 'STOCK',
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
});
const call = instrumentSchema.parse({
  ...stock,
  assetType: 'OPTION',
  optionRight: 'CALL',
  expiry: '2026-12-18',
  strike: '200',
  multiplier: '100',
  underlying: 'AAPL',
  deliverable: 'STANDARD',
});
const common = {
  effectiveAt: '2026-10-01T18:00:00Z',
  note: 'Offline golden case',
};
const base = () =>
  stateSchema.parse({
    accounts: [
      {
        accountKey: 'A',
        displayName: 'A',
        institution: 'Self-reported',
        accountType: 'CASH',
        baseCurrency: 'USD',
        active: true,
      },
    ],
    positions: [],
    cash: [{ accountKey: 'A', currency: 'USD', balance: '10000' }],
  });
const op = (input: Record<string, unknown>) =>
  operationSchema.parse({
    ...common,
    accountKey: 'A',
    instrument: stock,
    quantity: '1',
    price: '10',
    fees: '0',
    ...input,
  });
describe('decimal portfolio golden cases', () => {
  it('preserves unknown basis and refuses to fabricate realized profit', () => {
    const state = applyOperation(
      base(),
      op({ kind: 'STOCK_BUY', quantity: '10' }),
    ).state;
    state.positions[0]!.averageCost = null;
    state.positions[0]!.quality = 'UNKNOWN';
    expect(() => stateSchema.parse(state)).not.toThrow();
    expect(() => applyOperation(state, op({ kind: 'STOCK_SELL' }))).toThrow(
      'Unit cost is unknown',
    );
    expect(state.positions[0]!.averageCost).toBeNull();
  });
  it('rejects malformed decimals, fractional contracts and ambiguous deliverables', () => {
    expect(() => op({ kind: 'STOCK_BUY', price: 'NaN' })).toThrow();
    expect(() =>
      applyOperation(
        base(),
        op({ kind: 'OPTION_STO', instrument: call, quantity: '0.5' }),
      ),
    ).toThrow();
    expect(() =>
      instrumentSchema.parse({ ...call, multiplier: '150' }),
    ).toThrow();
    expect(instrumentKey(call)).not.toBe(
      instrumentKey({ ...call, strike: '201' }),
    );
    expect(instrumentKey(call)).not.toBe(
      instrumentKey({ ...call, expiry: '2026-12-19' }),
    );
  });
  it('uses exact decimal cash, weighted average cost, partial closes and fees', () => {
    let s = applyOperation(
      base(),
      op({ kind: 'STOCK_BUY', quantity: '10', price: '100', fees: '2' }),
    ).state;
    s = applyOperation(
      s,
      op({ kind: 'STOCK_BUY', quantity: '10', price: '120', fees: '2' }),
    ).state;
    expect(s.positions[0]?.averageCost).toBe('110.2');
    const closed = applyOperation(
      s,
      op({ kind: 'STOCK_SELL', quantity: '5', price: '130', fees: '1' }),
    );
    expect(closed.state.cash[0]?.balance).toBe('8445');
    expect(closed.state.positions[0]?.quantity).toBe('15');
    expect(closed.realized[0]?.amount).toBe('98');
    const tiny = applyOperation(
      base(),
      op({ kind: 'STOCK_BUY', quantity: '0.1', price: '0.2' }),
    );
    expect(tiny.state.cash[0]?.balance).toBe('9999.98');
  });
  it('short option premium changes cash, liability sign and closing P&L correctly', () => {
    const opened = applyOperation(
      base(),
      op({
        kind: 'OPTION_STO',
        instrument: call,
        quantity: '2',
        price: '3',
        fees: '2',
      }),
    );
    expect(opened.state.cash[0]?.balance).toBe('10598');
    expect(opened.state.positions[0]?.quantity).toBe('-2');
    expect(opened.realized).toEqual([]);
    expect(signedMarketValue(opened.state.positions[0]!, '4')).toBe('-800');
    expect(warnings(opened.state).join(' ')).toContain('uncovered');
    const close = applyOperation(
      opened.state,
      op({
        kind: 'OPTION_BTC',
        instrument: call,
        quantity: '1',
        price: '1',
        fees: '1',
      }),
    );
    expect(close.realized[0]?.amount).toBe('198');
    expect(close.state.cash[0]?.balance).toBe('10497');
    expect(close.state.positions[0]?.quantity).toBe('-1');
    expect(() =>
      applyOperation(
        opened.state,
        op({ kind: 'OPTION_BTO', instrument: call }),
      ),
    ).toThrow('opposite');
    expect(() =>
      applyOperation(
        opened.state,
        op({ kind: 'OPTION_BTC', instrument: call, quantity: '3' }),
      ),
    ).toThrow('exceeds');
  });
  it('transfers conserve each currency and sets/corrections never invent realized history', () => {
    let s = applyOperation(
      base(),
      operationSchema.parse({
        ...common,
        kind: 'ACCOUNT_UPSERT',
        account: { ...base().accounts[0], accountKey: 'B' },
      }),
    ).state;
    s = applyOperation(
      s,
      operationSchema.parse({
        ...common,
        kind: 'CASH_TRANSFER',
        accountKey: 'A',
        toAccountKey: 'B',
        currency: 'USD',
        amount: '123.45',
      }),
    ).state;
    expect(s.cash.map((c) => c.balance)).toEqual(['9876.55', '123.45']);
    const correction = applyOperation(
      s,
      operationSchema.parse({
        ...common,
        kind: 'ADJUST_POSITION',
        accountKey: 'A',
        instrument: stock,
        quantity: '100',
        averageCost: '10',
      }),
    );
    expect(correction.realized).toEqual([]);
    expect(correction.state.positions[0]?.quality).toBe('UNKNOWN');
    expect(correction.state.cash).toEqual(s.cash);
  });
  it('assignment atomically closes a short call, delivers stock and applies premium to proceeds', () => {
    let s = applyOperation(
      base(),
      op({ kind: 'STOCK_BUY', quantity: '100', price: '100' }),
    ).state;
    s = applyOperation(
      s,
      op({ kind: 'OPTION_STO', instrument: call, price: '3', fees: '1' }),
    ).state;
    expect(warnings(s).join(' ')).not.toContain('uncovered');
    const assigned = applyOperation(
      s,
      operationSchema.parse({
        ...common,
        kind: 'OPTION_ASSIGN',
        accountKey: 'A',
        instrument: call,
        quantity: '1',
        fees: '2',
        settlementConfirmed: true,
      }),
    );
    expect(assigned.state.cash[0]?.balance).toBe('20297');
    expect(assigned.state.positions.map((p) => p.quantity)).toEqual(['0', '0']);
    expect(assigned.realized[0]?.amount).toBe('10297');
    const uncovered = applyOperation(
      base(),
      op({ kind: 'OPTION_STO', instrument: call }),
    ).state;
    expect(() =>
      applyOperation(
        uncovered,
        operationSchema.parse({
          ...common,
          kind: 'OPTION_ASSIGN',
          accountKey: 'A',
          instrument: call,
          quantity: '1',
          fees: '0',
          settlementConfirmed: true,
        }),
      ),
    ).toThrow('insufficient');
    expect(uncovered.positions[0]?.quantity).toBe('-1');
  });
  it('short put assignment and long call exercise preserve premium in share basis', () => {
    const put = { ...call, optionRight: 'PUT' as const, strike: '100' };
    const opened = applyOperation(
      base(),
      op({ kind: 'OPTION_STO', instrument: put, price: '3', fees: '1' }),
    ).state;
    const assigned = applyOperation(
      opened,
      operationSchema.parse({
        ...common,
        kind: 'OPTION_ASSIGN',
        accountKey: 'A',
        instrument: put,
        quantity: '1',
        fees: '2',
        settlementConfirmed: true,
      }),
    );
    expect(assigned.state.cash[0]?.balance).toBe('297');
    expect(assigned.state.positions[1]?.averageCost).toBe('97.03');
    expect(assigned.realized).toEqual([]);
    const bought = applyOperation(
      base(),
      op({ kind: 'OPTION_BTO', instrument: call, price: '3', fees: '1' }),
    ).state;
    const exercised = applyOperation(
      bought,
      operationSchema.parse({
        ...common,
        kind: 'OPTION_EXERCISE',
        accountKey: 'A',
        instrument: call,
        quantity: '1',
        fees: '2',
        settlementConfirmed: true,
      }),
    );
    expect(exercised.state.cash[0]?.balance).toBe('-10303');
    expect(exercised.state.positions[1]?.averageCost).toBe('203.03');
  });
  it('expiration requires explicit verification and post-expiry effective date; split preserves book cost', () => {
    const s = applyOperation(
      base(),
      op({ kind: 'OPTION_STO', instrument: call, price: '3' }),
    ).state;
    const expire = {
      ...common,
      kind: 'OPTION_EXPIRE',
      accountKey: 'A',
      instrument: call,
      quantity: '1',
      fees: '0',
      settlementConfirmed: true,
    };
    expect(() => applyOperation(s, operationSchema.parse(expire))).toThrow(
      'after',
    );
    expect(
      applyOperation(
        s,
        operationSchema.parse({
          ...expire,
          effectiveAt: '2026-12-19T18:00:00Z',
        }),
      ).realized[0]?.amount,
    ).toBe('300');
    const held = applyOperation(
      base(),
      op({ kind: 'STOCK_BUY', quantity: '10', price: '100' }),
    ).state;
    const split = applyOperation(
      held,
      operationSchema.parse({
        ...common,
        kind: 'SPLIT',
        accountKey: 'A',
        instrument: stock,
        numerator: '2',
        denominator: '1',
      }),
    );
    expect(split.state.positions[0]).toMatchObject({
      quantity: '20',
      averageCost: '50',
    });
  });
  it('full replacement retains zeroed identities and deactivates absent accounts', () => {
    const initial = sevenAccountFixture(),
      next = structuredClone(initial);
    next.positions.pop();
    next.accounts.pop();
    next.cash.pop();
    const result = replacement(initial, next);
    expect(initial.positions[6]?.quantity).toBe('100');
    expect(result.positions[6]?.quantity).toBe('0');
    expect(result.accounts[6]?.active).toBe(false);
    expect(result.cash[6]?.balance).toBe('0');
  });
});
describe('canonical XLSX staging', () => {
  it('round trips seven overlapping accounts and decimal strings without numeric conversion', async () => {
    const fixture = sevenAccountFixture();
    fixture.cash[0]!.balance = '123456789012345678.123456789012';
    const parsed = await parseWorkbook(await workbook(fixture));
    expect(parsed.errors).toEqual([]);
    expect(parsed.state).toEqual(fixture);
  });
  it('reports row errors and rejects duplicate accounts, missing base cash and missing sheets', async () => {
    const fixture = sevenAccountFixture();
    fixture.positions[0]!.quantity = 'NaN';
    fixture.accounts.push(fixture.accounts[0]!);
    fixture.cash = [];
    const parsed = await parseWorkbook(await workbook(fixture));
    expect(parsed.state).toBeNull();
    expect(
      parsed.errors.some((e) => e.sheet === 'Positions' && e.row === 2),
    ).toBe(true);
    expect(parsed.errors.some((e) => e.message.includes('Duplicate'))).toBe(
      true,
    );
    expect(parsed.errors.some((e) => e.message.includes('cash'))).toBe(true);
    expect(
      (await parseWorkbook(Buffer.from('not xlsx'))).errors.length,
    ).toBeGreaterThan(0);
  });
  it('rejects formulas and oversized files rather than interpreting workbook content', async () => {
    const entries = unzipSync(await workbook(sevenAccountFixture()));
    const path = 'xl/worksheets/sheet1.xml';
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace(
        '</sheetData>',
        '<row r="99"><c r="A99"><f>1+1</f><v>2</v></c></row></sheetData>',
      ),
    );
    expect(
      (await parseWorkbook(Buffer.from(zipSync(entries)))).errors[0]?.message,
    ).toContain('Formula');
    await expect(
      parseWorkbook(Buffer.alloc(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow('2 MiB');
    expect(
      (await parseWorkbook(await workbook(emptyState()))).state,
    ).toBeNull();
  });
});
