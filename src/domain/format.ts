import { D, type Dec } from './decimal';

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function withThousands(s: string): string {
  const [int, frac] = s.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + grouped + (frac !== undefined ? `.${frac}` : '');
}

function fixed(value: Dec, dp: number, trim = false): string {
  const s = value.toDecimalPlaces(dp, D.ROUND_HALF_UP).toFixed(dp);
  return withThousands(trim ? trimZeros(s) : s);
}

const COUNT_LIKE = new Set(['pc', '份']);
const TWO_DP = new Set(['kg', 'L', '台斤']);

/**
 * 用量顯示規則（CLAUDE.md §3）：
 * g、ml 小於 10 顯示到小數 1 位，10 以上顯示整數；計數單位與其他單位顯示到小數 1 位；
 * kg、L、台斤顯示到小數 2 位。小數尾端的 0 省略。
 */
export function formatQty(value: Dec | null, unit: string): string {
  if (!value) return '—';
  if (unit === 'g' || unit === 'ml') {
    // 先進位到 0.1 再判斷，避免 9.95 顯示成「10.0」
    const oneDp = value.toDecimalPlaces(1, D.ROUND_HALF_UP);
    return oneDp.abs().lt(10) ? fixed(oneDp, 1, true) : fixed(value, 0);
  }
  if (TWO_DP.has(unit)) return fixed(value, 2, true);
  if (COUNT_LIKE.has(unit)) return fixed(value, 1, true);
  return fixed(value, 1, true);
}

/** 大量時的輔助單位，例如 14,286 g →「14.29 kg」 */
export function altUnitHint(value: Dec | null, unit: string): string | null {
  if (!value) return null;
  if (unit === 'g' && value.gte(1000)) return `${fixed(value.div(1000), 2, true)} kg`;
  if (unit === 'ml' && value.gte(1000)) return `${fixed(value.div(1000), 2, true)} L`;
  return null;
}

export const formatUnitCost = (v: Dec | null) => (v ? fixed(v, 4) : '—');
export const formatLineCost = (v: Dec | null) => (v ? fixed(v, 2) : '—');
export const formatServingCost = (v: Dec | null) => (v ? fixed(v, 1) : '—');
export const formatBatchCost = (v: Dec | null) => (v ? fixed(v, 0) : '—');
export const formatPrice = (v: Dec | null) => (v ? fixed(v, 0) : '—');
export const formatPercent = (v: Dec | null) => (v ? `${fixed(v.mul(100), 1)}%` : '—');
export const formatFactor = (v: Dec | null) => (v ? fixed(v, 4, true) : '—');

export function formatNumber(v: Dec | number | string | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  return fixed(new D(v), dp, true);
}
