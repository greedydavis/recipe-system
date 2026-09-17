import Decimal from 'decimal.js';

/** 所有金額與數量計算都用這個 Decimal（避免 JS 浮點數誤差） */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;
export type Numeric = number | string | Decimal;

export function dec(value: Numeric): Dec {
  return new D(value);
}

/** null、undefined、空字串都視為沒有值 */
export function decOrNull(value: Numeric | null | undefined): Dec | null {
  if (value === null || value === undefined || value === '') return null;
  return new D(value);
}

export type Result<T> = { ok: true; value: T } | { ok: false; issue: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(issue: string): Result<T> => ({ ok: false, issue });
