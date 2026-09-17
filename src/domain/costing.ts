import { D, type Dec, type Result, dec, decOrNull, fail, ok } from './decimal';
import type { CostingBundle, CostingIngredient, CostingLine, CostingVersion } from './types';
import {
  BASE_UNIT,
  convertOutputQty,
  ingredientBaseToGrams,
  outputQtyToGrams,
  toComponentOutputUnit,
  toIngredientBase,
} from './units';

export interface UnitCost {
  /** 每個基本單位（g、ml、個）的成本 */
  perBase: Dec;
  priceId: string;
  price: Dec;
  effectiveDate: string;
  specName: string;
  packBaseQty: Dec;
}

/** 原物料單位成本 = 預設包裝規格的有效單價 ÷ 規格換算成基本單位的數量 */
export function ingredientUnitCost(ingredient: CostingIngredient): Result<UnitCost> {
  const spec = ingredient.default_spec;
  if (!spec) return fail(`「${ingredient.name}」沒有預設包裝規格`);
  if (!spec.price) return fail(`「${ingredient.name}」沒有有效單價`);
  const packBase = toIngredientBase(dec(spec.pack_qty), spec.pack_unit, ingredient);
  if (!packBase.ok) return packBase;
  if (packBase.value.lte(0)) return fail(`「${ingredient.name}」的包裝數量必須大於 0`);
  const price = dec(spec.price.price);
  return ok({
    perBase: price.div(packBase.value),
    priceId: spec.price.id,
    price,
    effectiveDate: spec.price.effective_date,
    specName: spec.spec_name,
    packBaseQty: packBase.value,
  });
}

export interface LineCost {
  lineId: string;
  kind: CostingLine['line_kind'];
  name: string;
  groupLabel: string;
  prepNote: string;
  quantity: Dec | null;
  unit: string;
  /** 原物料：基本單位淨重；元件：被引用版本的產出單位數量 */
  baseQty: Dec | null;
  baseUnit: string;
  wasteRate: Dec;
  /** 原物料採購量（基本單位）；元件等於 baseQty */
  purchaseQty: Dec | null;
  /** 每個基本單位（或產出單位）的成本 */
  unitCost: Dec | null;
  cost: Dec | null;
  /** 投入淨重（公克），計算出成率用 */
  gramWeight: Dec | null;
  priceId: string | null;
  componentVersionId: string | null;
  issues: string[];
}

export interface VersionCost {
  versionId: string;
  recipeType: CostingVersion['recipe_type'];
  lines: LineCost[];
  /** 已知行成本的合計（不完整時也會有值） */
  knownCost: Dec;
  /** 完整時才有值 */
  batchCost: Dec | null;
  isComplete: boolean;
  issues: string[];
  inputWeightG: Dec | null;
  outputWeightG: Dec | null;
  yieldRate: Dec | null;
  outputUnit: CostingVersion['batch_output_unit'];
  batchOutputQty: Dec | null;
  /** 每單位產出（g 或 ml）的成本 */
  costPerOutputUnit: Dec | null;
  servingCost: Dec | null;
  servingsPerBatch: Dec | null;
}

export class CostCalculator {
  private memo = new Map<string, VersionCost>();
  private stack = new Set<string>();

  constructor(private bundle: CostingBundle) {}

  version(versionId: string): VersionCost {
    const cached = this.memo.get(versionId);
    if (cached) return cached;
    const version = this.bundle.versions[versionId];
    if (!version) throw new Error(`成本資料缺少版本 ${versionId}`);
    this.stack.add(versionId);
    const result = this.compute(version);
    this.stack.delete(versionId);
    this.memo.set(versionId, result);
    return result;
  }

  private compute(version: CostingVersion): VersionCost {
    const lines = version.lines
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line) => this.line(line));
    const issues: string[] = [];
    let known = new D(0);
    let complete = true;
    let inputWeight: Dec | null = new D(0);
    for (const l of lines) {
      if (l.cost) known = known.add(l.cost);
      else complete = false;
      issues.push(...l.issues);
      inputWeight = inputWeight && l.gramWeight ? inputWeight.add(l.gramWeight) : null;
    }
    if (lines.length === 0) {
      complete = false;
      issues.push('還沒有任何用料');
      inputWeight = null;
    }

    const outputQty = decOrNull(version.batch_output_qty);
    const outputUnit = version.batch_output_unit;
    const servingQty = decOrNull(version.serving_qty);
    let costPerOutputUnit: Dec | null = null;
    let servingCost: Dec | null = null;
    let servingsPerBatch: Dec | null = null;
    let outputWeightG: Dec | null = null;

    if (!outputQty || !outputUnit) {
      complete = false;
      issues.push(version.recipe_type === 'dish' ? '每份量未填' : '批次產量未填');
    } else {
      outputWeightG = outputQtyToGrams(outputQty, outputUnit, version);
      if (servingQty && version.serving_unit) {
        const servingInOutput = convertOutputQty(servingQty, version.serving_unit, outputUnit, version);
        if (servingInOutput.ok) servingsPerBatch = outputQty.div(servingInOutput.value);
      }
    }
    if (!servingQty || !version.serving_unit) {
      if (version.recipe_type === 'component') {
        complete = false;
        issues.push('每份量未填');
      }
    }

    const batchCost = complete ? known : null;
    if (batchCost && outputQty && outputUnit) {
      costPerOutputUnit = batchCost.div(outputQty);
      if (version.recipe_type === 'dish') {
        servingCost = batchCost;
      } else if (servingQty && version.serving_unit) {
        const servingInOutput = convertOutputQty(servingQty, version.serving_unit, outputUnit, version);
        if (servingInOutput.ok) servingCost = costPerOutputUnit.mul(servingInOutput.value);
        else {
          issues.push(servingInOutput.issue);
        }
      }
    }

    const yieldRate =
      inputWeight && outputWeightG && inputWeight.gt(0) ? outputWeightG.div(inputWeight) : null;

    return {
      versionId: version.id,
      recipeType: version.recipe_type,
      lines,
      knownCost: known,
      batchCost,
      isComplete: complete && servingCost !== null,
      issues: [...new Set(issues)],
      inputWeightG: inputWeight,
      outputWeightG,
      yieldRate,
      outputUnit,
      batchOutputQty: outputQty,
      costPerOutputUnit,
      servingCost,
      servingsPerBatch,
    };
  }

  private line(line: CostingLine): LineCost {
    const base: LineCost = {
      lineId: line.id,
      kind: line.line_kind,
      name: '',
      groupLabel: line.group_label ?? '',
      prepNote: line.prep_note ?? '',
      quantity: decOrNull(line.quantity),
      unit: line.unit,
      baseQty: null,
      baseUnit: '',
      wasteRate: new D(0),
      purchaseQty: null,
      unitCost: null,
      cost: null,
      gramWeight: null,
      priceId: null,
      componentVersionId: line.component_version_id,
      issues: [],
    };
    return line.line_kind === 'ingredient' ? this.ingredientLine(line, base) : this.componentLine(line, base);
  }

  private ingredientLine(line: CostingLine, out: LineCost): LineCost {
    const ingredient = line.ingredient_id ? this.bundle.ingredients[line.ingredient_id] : undefined;
    if (!ingredient) {
      out.name = '（找不到原物料）';
      out.issues.push('成本資料缺少原物料');
      return out;
    }
    out.name = ingredient.name;
    out.baseUnit = BASE_UNIT[ingredient.base_dimension];
    out.wasteRate = decOrNull(line.waste_rate_override) ?? dec(ingredient.default_waste_rate);
    if (out.wasteRate.lt(0) || out.wasteRate.gte(1)) {
      out.issues.push(`「${ingredient.name}」損耗率必須介於 0% 與 100% 之間`);
      return out;
    }
    const unitCost = ingredientUnitCost(ingredient);
    if (unitCost.ok) {
      out.unitCost = unitCost.value.perBase;
      out.priceId = unitCost.value.priceId;
    } else {
      out.issues.push(unitCost.issue);
    }
    if (!out.quantity) {
      out.issues.push(`「${ingredient.name}」用量待填`);
      return out;
    }
    const baseQty = toIngredientBase(out.quantity, line.unit, ingredient);
    if (!baseQty.ok) {
      out.issues.push(baseQty.issue);
      return out;
    }
    out.baseQty = baseQty.value;
    out.gramWeight = ingredientBaseToGrams(baseQty.value, ingredient);
    out.purchaseQty = baseQty.value.div(new D(1).sub(out.wasteRate));
    if (out.unitCost) out.cost = out.purchaseQty.mul(out.unitCost);
    return out;
  }

  private componentLine(line: CostingLine, out: LineCost): LineCost {
    const component = line.component_version_id ? this.bundle.versions[line.component_version_id] : undefined;
    if (!component) {
      out.name = '（找不到元件版本）';
      out.issues.push('成本資料缺少元件版本');
      return out;
    }
    out.name = `${component.recipe_name} v${component.version_no}`;
    out.baseUnit = component.batch_output_unit ?? '';
    if (this.stack.has(component.id)) {
      out.issues.push(`「${component.recipe_name}」形成循環引用`);
      return out;
    }
    const sub = this.version(component.id);
    if (sub.costPerOutputUnit) out.unitCost = sub.costPerOutputUnit;
    else out.issues.push(`元件「${component.recipe_name}」v${component.version_no} 成本不完整`);
    if (!out.quantity) {
      out.issues.push(`「${component.recipe_name}」用量待填`);
      return out;
    }
    const qty = toComponentOutputUnit(out.quantity, line.unit, component);
    if (!qty.ok) {
      out.issues.push(qty.issue);
      return out;
    }
    out.baseQty = qty.value;
    out.purchaseQty = qty.value;
    if (component.batch_output_unit) {
      out.gramWeight = outputQtyToGrams(qty.value, component.batch_output_unit, component);
    }
    if (out.unitCost) out.cost = qty.value.mul(out.unitCost);
    return out;
  }
}

export function computeVersionCost(bundle: CostingBundle, versionId: string): VersionCost {
  return new CostCalculator(bundle).version(versionId);
}
