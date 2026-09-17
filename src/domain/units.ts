import { type Dec, type Result, dec, decOrNull, fail, ok } from './decimal';
import type { CostingIngredient, CostingVersion, Dimension, OutputUnit } from './types';

export interface GlobalUnit {
  code: string;
  name_zh: string;
  dimension: Dimension;
  factor_to_base: string;
  sort_order: number;
}

/** 必須和 supabase/migrations 的 app.units 一致（db-tests 會比對） */
export const GLOBAL_UNITS: GlobalUnit[] = [
  { code: 'g', name_zh: '公克', dimension: 'mass', factor_to_base: '1', sort_order: 10 },
  { code: 'kg', name_zh: '公斤', dimension: 'mass', factor_to_base: '1000', sort_order: 20 },
  { code: '台斤', name_zh: '台斤', dimension: 'mass', factor_to_base: '600', sort_order: 30 },
  { code: '兩', name_zh: '台兩', dimension: 'mass', factor_to_base: '37.5', sort_order: 40 },
  { code: 'ml', name_zh: '毫升', dimension: 'volume', factor_to_base: '1', sort_order: 50 },
  { code: 'L', name_zh: '公升', dimension: 'volume', factor_to_base: '1000', sort_order: 60 },
  { code: '大匙', name_zh: '大匙', dimension: 'volume', factor_to_base: '15', sort_order: 70 },
  { code: '小匙', name_zh: '小匙', dimension: 'volume', factor_to_base: '5', sort_order: 80 },
  { code: 'pc', name_zh: '個', dimension: 'count', factor_to_base: '1', sort_order: 90 },
];

export const BASE_UNIT: Record<Dimension, string> = { mass: 'g', volume: 'ml', count: 'pc' };

/** 引用元件時可用的單位（「份」＝該元件版本的每份量） */
export const COMPONENT_LINE_UNITS = ['g', 'kg', '台斤', '兩', 'ml', 'L', '份'];

const unitByCode = new Map(GLOBAL_UNITS.map((u) => [u.code, u]));

export function globalUnit(code: string): GlobalUnit | undefined {
  return unitByCode.get(code);
}

export function unitLabel(code: string): string {
  if (code === 'pc') return '個';
  return code;
}

/** 在「質量／體積」之間換算；需要密度（g/ml） */
function convertDimension(
  qty: Dec,
  from: Dimension,
  to: Dimension,
  density: Dec | null,
  subject: string,
): Result<Dec> {
  if (from === to) return ok(qty);
  if (from === 'mass' && to === 'volume') {
    if (!density) return fail(`${subject}沒有設定密度，無法把重量換算成容量`);
    return ok(qty.div(density));
  }
  if (from === 'volume' && to === 'mass') {
    if (!density) return fail(`${subject}沒有設定密度，無法把容量換算成重量`);
    return ok(qty.mul(density));
  }
  return fail(`${subject}無法把「${dimensionLabel(from)}」換算成「${dimensionLabel(to)}」`);
}

export function dimensionLabel(d: Dimension): string {
  return d === 'mass' ? '重量' : d === 'volume' ? '容量' : '個數';
}

/** 把原物料的某個用量換算成該原物料的基本單位（g、ml 或個） */
export function toIngredientBase(qty: Dec, unit: string, ingredient: CostingIngredient): Result<Dec> {
  const custom = ingredient.units.find((u) => u.unit_name === unit);
  if (custom) return ok(qty.mul(dec(custom.qty_in_base)));
  const g = globalUnit(unit);
  if (!g) return fail(`「${ingredient.name}」沒有「${unit}」這個單位`);
  const inOwnBase = qty.mul(dec(g.factor_to_base));
  return convertDimension(
    inOwnBase,
    g.dimension,
    ingredient.base_dimension,
    decOrNull(ingredient.density_g_per_ml),
    `「${ingredient.name}」`,
  );
}

/** 原物料基本單位的數量換算成公克（計算出成率用）；無法換算時回傳 null */
export function ingredientBaseToGrams(baseQty: Dec, ingredient: CostingIngredient): Dec | null {
  if (ingredient.base_dimension === 'mass') return baseQty;
  if (ingredient.base_dimension === 'volume') {
    const density = decOrNull(ingredient.density_g_per_ml);
    return density ? baseQty.mul(density) : null;
  }
  return null;
}

function outputDimension(unit: OutputUnit): Dimension {
  return unit === 'g' ? 'mass' : 'volume';
}

/** 把「產出單位（g／ml）」之間的數量換算，跨質量與容量時用成品密度 */
export function convertOutputQty(
  qty: Dec,
  from: OutputUnit,
  to: OutputUnit,
  version: CostingVersion,
): Result<Dec> {
  return convertDimension(
    qty,
    outputDimension(from),
    outputDimension(to),
    decOrNull(version.output_density_g_per_ml),
    `「${version.recipe_name}」v${version.version_no} `,
  );
}

/** 引用元件的用量換算成被引用版本的「批次產量單位」 */
export function toComponentOutputUnit(qty: Dec, unit: string, component: CostingVersion): Result<Dec> {
  const outUnit = component.batch_output_unit;
  const label = `「${component.recipe_name}」v${component.version_no}`;
  if (!outUnit) return fail(`${label}沒有設定批次產量單位`);
  if (unit === '份') {
    const serving = decOrNull(component.serving_qty);
    if (!serving || !component.serving_unit) return fail(`${label}沒有設定每份量，不能用「份」`);
    return convertOutputQty(qty.mul(serving), component.serving_unit, outUnit, component);
  }
  const g = globalUnit(unit);
  if (!g || g.dimension === 'count' || !['g', 'kg', '台斤', '兩', 'ml', 'L'].includes(unit)) {
    return fail(`${label}不能用「${unit}」當單位`);
  }
  const base = qty.mul(dec(g.factor_to_base));
  return convertOutputQty(base, g.dimension === 'mass' ? 'g' : 'ml', outUnit, component);
}

/** 產出單位的數量換算成公克；ml 需要成品密度 */
export function outputQtyToGrams(qty: Dec, unit: OutputUnit, version: CostingVersion): Dec | null {
  if (unit === 'g') return qty;
  const density = decOrNull(version.output_density_g_per_ml);
  return density ? qty.mul(density) : null;
}
