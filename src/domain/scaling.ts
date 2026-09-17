import { type Dec, type Result, dec, decOrNull, fail, ok } from './decimal';
import type { CostingVersion, OutputUnit } from './types';
import { convertOutputQty } from './units';

export type ScaleMode =
  | { kind: 'servings'; servings: number | string }
  | { kind: 'batches'; batches: number | string }
  | { kind: 'output'; qty: number | string; unit: OutputUnit };

/** 份量換算倍率：目標產量 ÷ 批次產量；時間、溫度不跟著縮放 */
export function scaleFactor(
  version: Pick<
    CostingVersion,
    'recipe_type' | 'recipe_name' | 'version_no' | 'batch_output_qty' | 'batch_output_unit' | 'serving_qty' | 'serving_unit' | 'output_density_g_per_ml'
  >,
  mode: ScaleMode,
): Result<Dec> {
  const batchQty = decOrNull(version.batch_output_qty);
  const batchUnit = version.batch_output_unit;
  if (!batchQty || !batchUnit) return fail('批次產量未填，無法換算份量');
  const full = version as CostingVersion;

  switch (mode.kind) {
    case 'batches': {
      const n = dec(mode.batches);
      if (n.lte(0)) return fail('批次數必須大於 0');
      return ok(n);
    }
    case 'servings': {
      const n = dec(mode.servings);
      if (n.lte(0)) return fail('份數必須大於 0');
      const servingQty = decOrNull(version.serving_qty);
      if (!servingQty || !version.serving_unit) return fail('每份量未填，無法換算份數');
      const perServing = convertOutputQty(servingQty, version.serving_unit, batchUnit, full);
      if (!perServing.ok) return perServing;
      return ok(n.mul(perServing.value).div(batchQty));
    }
    case 'output': {
      const target = dec(mode.qty);
      if (target.lte(0)) return fail('目標產量必須大於 0');
      const converted = convertOutputQty(target, mode.unit, batchUnit, full);
      if (!converted.ok) return converted;
      return ok(converted.value.div(batchQty));
    }
  }
}

export function scaleQty(quantity: Dec | null, factor: Dec): Dec | null {
  return quantity ? quantity.mul(factor) : null;
}
