import { ingredientUnitCost } from '../domain/costing';
import { type Dec, dec } from '../domain/decimal';
import { formatLineCost } from '../domain/format';
import type { CostingIngredient, Dimension } from '../domain/types';
import { toIngredientBase } from '../domain/units';
import { toNum } from './format';

/** 每基本單位的價格 → 好讀的寫法：g／ml 換算成每公斤／每公升 */
export function perBaseText(perBase: Dec, dimension: Dimension): string {
  if (dimension === 'mass') return `$${formatLineCost(perBase.mul(1000))}/kg`;
  if (dimension === 'volume') return `$${formatLineCost(perBase.mul(1000))}/L`;
  return `$${formatLineCost(perBase)}/個`;
}

/** 原物料目前的單價；缺價格時回傳原因 */
export function priceDisplay(ing: CostingIngredient): { text: string; missing: boolean } {
  const r = ingredientUnitCost(ing);
  if (!r.ok) return { text: r.issue.replace(`「${ing.name}」`, ''), missing: true };
  return { text: perBaseText(r.value.perBase, ing.base_dimension), missing: false };
}

/** 原物料清單的「食譜使用」篩選；null 是全部 */
export type UsageFilter = 'used' | 'unused' | null;

export const USAGE_OPTIONS: Array<{ value: 'used' | 'unused'; label: string }> = [
  { value: 'used', label: '有食譜用到' },
  { value: 'unused', label: '沒有食譜用到' },
];

export function matchesUsage(usedInCount: number, filter: UsageFilter): boolean {
  if (filter === 'used') return usedInCount > 0;
  if (filter === 'unused') return usedInCount === 0;
  return true;
}

/** 輸入進貨金額用的一行：包裝數量、單位、金額（都是表單字串） */
export interface PriceEntry {
  qty: string;
  unit: string;
  price: string;
}

/** 先帶入預設規格的包裝；沒有規格時用 kg／L／個 */
export function defaultPriceEntry(ing: CostingIngredient): PriceEntry {
  const spec = ing.default_spec;
  return {
    qty: spec ? String(spec.pack_qty) : '',
    unit: spec?.pack_unit ?? (ing.base_dimension === 'mass' ? 'kg' : ing.base_dimension === 'volume' ? 'L' : 'pc'),
    price: '',
  };
}

/** 這次填的包裝與金額換算成的單價；填不完整或單位換不過去時回傳 null */
export function entryUnitPrice(ing: CostingIngredient, entry: PriceEntry): string | null {
  const qty = toNum(entry.qty);
  const price = toNum(entry.price);
  if (qty === null || qty <= 0 || price === null) return null;
  const base = toIngredientBase(dec(entry.qty), entry.unit, ing);
  if (!base.ok || base.value.lte(0)) return null;
  return perBaseText(dec(entry.price).div(base.value), ing.base_dimension);
}
