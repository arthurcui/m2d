import { Decimal } from 'decimal.js';
import type { State } from './contracts.js';
export function countShares(
  state: State,
  symbol: string,
  accountKey?: string,
): string {
  return state.positions
    .filter(
      (p) =>
        p.instrument.assetType !== 'OPTION' &&
        p.instrument.symbol.toUpperCase() === symbol.toUpperCase() &&
        (!accountKey || p.accountKey === accountKey),
    )
    .reduce((total, p) => total.plus(p.quantity), new Decimal(0))
    .toFixed();
}
