import { Decimal } from 'decimal.js';
import {
  type State,
  type Operation,
  type Instrument,
  type Position,
  type Change,
  type Realized,
  stateSchema,
  instrumentKey,
  fail,
} from './contracts.js';
// Extra precision for intermediates; persisted decimal strings have an explicit 12-place scale.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });
const knownCost = (p: Position) =>
  p.averageCost ??
  fail(
    'COST_UNKNOWN',
    'Unit cost is unknown. Supply a confirmed cost correction before cost-dependent ledger changes.',
  );
const s = (v: Decimal) => v.toDecimalPlaces(12).toFixed();
const weakerQuality = (
  a: Position['quality'],
  b: Position['quality'],
): Position['quality'] =>
  a === 'UNKNOWN' || b === 'UNKNOWN'
    ? 'UNKNOWN'
    : a === 'BASELINE_ESTIMATE' || b === 'BASELINE_ESTIMATE'
      ? 'BASELINE_ESTIMATE'
      : 'COMPLETE_LEDGER';
export function applyOperation(
  input: State,
  op: Operation,
): { state: State; realized: Realized[] } {
  const state = structuredClone(input);
  const realized: Realized[] = [];
  const active = (id: string) =>
    state.accounts.find((a) => a.accountKey === id && a.active) ??
    fail('UNKNOWN_ACCOUNT', 'Select an active account.');
  const cash = (id: string, currency: string, delta: Decimal, set = false) => {
    let row = state.cash.find(
      (c) => c.accountKey === id && c.currency === currency,
    );
    if (!row) {
      row = { accountKey: id, currency, balance: '0' };
      state.cash.push(row);
    }
    row.balance = s(set ? delta : new D(row.balance).plus(delta));
  };
  const position = (id: string, i: Instrument) => {
    let p = state.positions.find(
      (p) =>
        p.accountKey === id && instrumentKey(p.instrument) === instrumentKey(i),
    );
    if (!p) {
      p = {
        accountKey: id,
        instrument: i,
        quantity: '0',
        averageCost: '0',
        quality: 'COMPLETE_LEDGER',
        notes: '',
      };
      state.positions.push(p);
    }
    return p;
  };
  const trade = (
    id: string,
    i: Instrument,
    q: Decimal,
    price: Decimal,
    fees: Decimal,
    side: 1 | -1,
    opening: boolean,
  ) => {
    const p = position(id, i),
      old = new D(p.quantity),
      mult = new D(i.multiplier);
    if (opening && !old.isZero() && old.isPositive() !== (side === 1))
      fail(
        'POSITION_SIDE_CONFLICT',
        'Close the existing opposite position before opening a new one.',
      );
    if (
      !opening &&
      (old.isZero() || old.isPositive() === (side === 1) || old.abs().lt(q))
    )
      fail(
        'INSUFFICIENT_POSITION',
        'Closing quantity exceeds the matching position.',
      );
    const gross = q.mul(price).mul(mult);
    if (opening) {
      if (old.isZero()) {
        p.quality = 'COMPLETE_LEDGER';
        p.averageCost = '0';
      }
      const cost = old
        .abs()
        .mul(knownCost(p))
        .mul(mult)
        .plus(gross)
        .plus(side === 1 ? fees : fees.neg());
      if (cost.lt(0))
        fail(
          'VALIDATION_ERROR',
          'Opening fees exceed premium; reconcile using a documented adjustment.',
        );
      p.averageCost = s(cost.div(old.abs().plus(q).mul(mult)));
    } else {
      const pnl = (
        old.gt(0) ? price.minus(knownCost(p)) : new D(knownCost(p)).minus(price)
      )
        .mul(q)
        .mul(mult)
        .minus(fees);
      realized.push({
        accountKey: id,
        currency: i.currency,
        amount: s(pnl),
        quality: p.quality,
      });
    }
    p.quantity = s(old.plus(q.mul(side)));
    if (new D(p.quantity).isZero()) p.averageCost = '0';
    cash(id, i.currency, gross.mul(-side).minus(fees));
  };
  if (op.kind === 'ACCOUNT_UPSERT') {
    const idx = state.accounts.findIndex(
      (a) => a.accountKey === op.account.accountKey,
    );
    if (idx < 0) state.accounts.push(op.account);
    else state.accounts[idx] = op.account;
    if (
      !state.cash.some(
        (c) =>
          c.accountKey === op.account.accountKey &&
          c.currency === op.account.baseCurrency,
      )
    )
      cash(op.account.accountKey, op.account.baseCurrency, new D(0));
  } else if (op.kind === 'NOTE_ONLY') {
    active(op.accountKey);
  } else {
    active(op.accountKey);
    if (op.kind === 'CASH_TRANSFER') {
      active(op.toAccountKey);
      if (op.toAccountKey === op.accountKey)
        fail('VALIDATION_ERROR', 'Transfer accounts must differ.');
      cash(op.accountKey, op.currency, new D(op.amount).neg());
      cash(op.toAccountKey, op.currency, new D(op.amount));
    } else if ('amount' in op) {
      if (op.kind !== 'CASH_SET' && new D(op.amount).lte(0))
        fail('VALIDATION_ERROR', 'Enter a positive amount.');
      cash(
        op.accountKey,
        op.currency,
        new D(op.amount).mul(
          ['CASH_WITHDRAW', 'FEE'].includes(op.kind) ? -1 : 1,
        ),
        op.kind === 'CASH_SET',
      );
    } else if (op.kind === 'ADJUST_POSITION') {
      const p = position(op.accountKey, op.instrument);
      p.quantity = op.quantity;
      p.averageCost = new D(op.quantity).isZero() ? '0' : op.averageCost;
      p.quality = 'UNKNOWN';
      p.notes = op.note;
    } else if (op.kind === 'SPLIT') {
      if (op.instrument.assetType === 'OPTION')
        fail(
          'UNKNOWN_OPTION_CONTRACT',
          'Option corporate actions require an explicit replacement baseline.',
        );
      const p = position(op.accountKey, op.instrument),
        ratio = new D(op.numerator).div(op.denominator);
      p.quantity = s(new D(p.quantity).mul(ratio));
      if (p.averageCost !== null)
        p.averageCost = s(new D(p.averageCost).div(ratio));
    } else if ('price' in op) {
      const option = op.kind.startsWith('OPTION_');
      if (option !== (op.instrument.assetType === 'OPTION'))
        fail('VALIDATION_ERROR', 'Action and instrument type do not match.');
      if (
        option &&
        (!new D(op.quantity).isInteger() ||
          op.instrument.expiry! < op.effectiveAt.slice(0, 10))
      )
        fail(
          'UNKNOWN_OPTION_CONTRACT',
          'Contract quantity must be whole and trade cannot occur after expiration.',
        );
      const buy = [
        'STOCK_BUY',
        'STOCK_COVER',
        'OPTION_BTO',
        'OPTION_BTC',
      ].includes(op.kind);
      const opening = [
        'STOCK_BUY',
        'STOCK_SHORT',
        'OPTION_BTO',
        'OPTION_STO',
      ].includes(op.kind);
      trade(
        op.accountKey,
        op.instrument,
        new D(op.quantity),
        new D(op.price),
        new D(op.fees),
        buy ? 1 : -1,
        opening,
      );
    } else {
      const i = op.instrument,
        p = position(op.accountKey, i),
        old = new D(p.quantity),
        q = new D(op.quantity);
      if (
        i.assetType !== 'OPTION' ||
        !q.isInteger() ||
        old.abs().lt(q) ||
        old.isZero()
      )
        fail(
          'INSUFFICIENT_POSITION',
          'Select sufficient whole option contracts.',
        );
      if (op.kind === 'OPTION_EXPIRE') {
        if (op.effectiveAt.slice(0, 10) <= i.expiry!)
          fail(
            'VALIDATION_ERROR',
            'Record expiration after the expiry date, with verified non-exercise status.',
          );
        trade(
          op.accountKey,
          i,
          q,
          new D(0),
          new D(op.fees),
          old.gt(0) ? -1 : 1,
          false,
        );
      } else {
        if (
          (op.kind === 'OPTION_ASSIGN' && old.gt(0)) ||
          (op.kind === 'OPTION_EXERCISE' && old.lt(0))
        )
          fail(
            'POSITION_SIDE_CONFLICT',
            'Assignment closes short options; exercise closes long options.',
          );
        const matches = state.positions.filter(
          (x) =>
            x.accountKey === op.accountKey &&
            x.instrument.assetType !== 'OPTION' &&
            x.instrument.symbol === i.underlying &&
            x.instrument.exchange === i.exchange &&
            x.instrument.currency === i.currency,
        );
        if (matches.length > 1)
          fail(
            'UNKNOWN_OPTION_CONTRACT',
            'Underlying identity is ambiguous; reconcile it before settlement.',
          );
        const stock: Instrument = matches[0]?.instrument ?? {
          assetType: 'STOCK',
          symbol: i.underlying!,
          exchange: i.exchange,
          currency: i.currency,
          optionRight: null,
          expiry: null,
          strike: null,
          multiplier: '1',
          underlying: null,
          deliverable: null,
        };
        const shares = q.mul(i.multiplier),
          buy = (i.optionRight === 'CALL') === old.gt(0);
        const underlying = position(op.accountKey, stock);
        if (!buy && new D(underlying.quantity).lt(shares))
          fail(
            'INSUFFICIENT_POSITION',
            'Deliverable shares are insufficient. M1 does not infer an assignment-created stock short.',
          );
        if (buy && new D(underlying.quantity).lt(0))
          fail(
            'POSITION_SIDE_CONFLICT',
            'Reconcile the existing stock short before settlement.',
          );
        // Preserve option premium in the stock basis/proceeds, not instant realized premium.
        const adjusted = new D(i.strike!).plus(
          i.optionRight === 'CALL'
            ? new D(knownCost(p))
            : new D(knownCost(p)).neg(),
        );
        if (adjusted.lt(0))
          fail(
            'VALIDATION_ERROR',
            'Settlement basis is negative; explicit reconciliation is required.',
          );
        trade(
          op.accountKey,
          stock,
          shares,
          adjusted,
          new D(op.fees),
          buy ? 1 : -1,
          buy,
        );
        // Actual cash settlement is strike, while adjusted price is solely accounting basis.
        cash(
          op.accountKey,
          i.currency,
          shares.mul(adjusted.minus(i.strike!)).mul(buy ? 1 : -1),
        );
        underlying.quality = weakerQuality(underlying.quality, p.quality);
        for (const r of realized)
          r.quality = weakerQuality(r.quality, p.quality);
        p.quantity = s(old.plus(q.mul(old.gt(0) ? -1 : 1)));
        if (new D(p.quantity).isZero()) p.averageCost = '0';
      }
    }
  }
  return { state: stateSchema.parse(state), realized };
}
export function replacement(current: State, uploaded: State): State {
  const next = structuredClone(uploaded);
  for (const a of current.accounts)
    if (!next.accounts.some((n) => n.accountKey === a.accountKey))
      next.accounts.push({ ...a, active: false });
  for (const p of current.positions)
    if (
      !next.positions.some(
        (n) =>
          n.accountKey === p.accountKey &&
          instrumentKey(n.instrument) === instrumentKey(p.instrument),
      )
    )
      next.positions.push({
        ...p,
        quantity: '0',
        averageCost: '0',
        quality: 'BASELINE_ESTIMATE',
      });
  for (const c of current.cash)
    if (
      !next.cash.some(
        (n) => n.accountKey === c.accountKey && n.currency === c.currency,
      )
    )
      next.cash.push({ ...c, balance: '0' });
  return stateSchema.parse(next);
}
export function diff(before: State, after: State): Change[] {
  const rows = (state: State) =>
    new Map<string, { area: Change['area']; value: string }>([
      ...state.accounts.map(
        (a) =>
          [
            `account:${a.accountKey}`,
            { area: 'account' as const, value: JSON.stringify(a) },
          ] as const,
      ),
      ...state.positions.map(
        (p) =>
          [
            `position:${p.accountKey}:${instrumentKey(p.instrument)}`,
            {
              area: 'position' as const,
              value: `${p.quantity} @ ${p.averageCost ?? 'Unknown cost'} ${p.instrument.currency} (${p.quality})${p.optionGroup ? ` · Group: ${p.optionGroup}` : ''}${p.description ? ` · ${p.description}` : ''}${p.transactionDate ? ` · Transaction date: ${p.transactionDate}` : ''}`,
            },
          ] as const,
      ),
      ...state.cash.map(
        (c) =>
          [
            `cash:${c.accountKey}:${c.currency}`,
            { area: 'cash' as const, value: c.balance },
          ] as const,
      ),
    ]);
  const b = rows(before),
    a = rows(after);
  return [...new Set([...b.keys(), ...a.keys()])].flatMap((key) =>
    b.get(key)?.value === a.get(key)?.value
      ? []
      : [
          {
            area: (a.get(key) ?? b.get(key))!.area,
            key,
            before: b.get(key)?.value ?? 'Not recorded',
            after: a.get(key)?.value ?? 'Removed',
          },
        ],
  );
}
export function warnings(state: State): string[] {
  const out = [
    'Self-reported state; no broker verification. Market valuation and pre-baseline realized P&L are unknown.',
  ];
  for (const c of state.cash)
    if (new D(c.balance).lt(0))
      out.push(
        `Negative ${c.currency} cash in ${c.accountKey}; this is not a broker buying-power check.`,
      );
  for (const p of state.positions)
    if (p.instrument.assetType === 'OPTION' && new D(p.quantity).lt(0)) {
      out.push(
        `${p.accountKey}: short ${p.instrument.symbol} is an obligation, not premium profit.`,
      );
      if (p.instrument.optionRight === 'CALL') {
        const calls = state.positions.filter(
          (x) =>
            x.accountKey === p.accountKey &&
            x.instrument.assetType === 'OPTION' &&
            x.instrument.underlying === p.instrument.underlying &&
            x.instrument.currency === p.instrument.currency &&
            x.instrument.optionRight === 'CALL' &&
            new D(x.quantity).lt(0),
        );
        const required = calls.reduce(
          (n, x) =>
            n.plus(new D(x.quantity).abs().mul(x.instrument.multiplier)),
          new D(0),
        );
        const held = state.positions
          .filter(
            (x) =>
              x.accountKey === p.accountKey &&
              x.instrument.assetType !== 'OPTION' &&
              x.instrument.symbol === p.instrument.underlying &&
              x.instrument.currency === p.instrument.currency,
          )
          .reduce((n, x) => n.plus(x.quantity), new D(0));
        if (held.lt(required))
          out.push(
            `${p.accountKey}: uncovered call obligations for ${p.instrument.underlying}; ${required} shares required, ${held} recorded.`,
          );
      }
    }
  return [...new Set(out)];
}
export function signedMarketValue(p: Position, mark: string): string {
  return s(new D(p.quantity).mul(mark).mul(p.instrument.multiplier));
}
