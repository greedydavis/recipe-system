import type { VersionCost } from './costing';
import type { PriceMetrics } from './pricing';

export interface CostSnapshotPayload {
  is_complete: boolean;
  batch_cost: string | null;
  cost_per_serving: string | null;
  yield_rate: string | null;
  menu_price: string | null;
  food_cost_rate: string | null;
  detail: {
    as_of: string;
    issues: string[];
    lines: Array<{
      line_id: string;
      kind: string;
      name: string;
      quantity: string | null;
      unit: string;
      base_qty: string | null;
      base_unit: string;
      waste_rate: string;
      purchase_qty: string | null;
      unit_cost: string | null;
      cost: string | null;
      purchase_price_id: string | null;
      component_version_id: string | null;
    }>;
  };
}

const s = (v: { toString(): string } | null) => (v ? v.toString() : null);

/** 定版時寫入 cost_snapshots 的內容：保留未進位的數值與使用的價格 id，事後可以重算驗證 */
export function buildSnapshot(cost: VersionCost, metrics: PriceMetrics, asOf: string): CostSnapshotPayload {
  return {
    is_complete: cost.isComplete,
    batch_cost: s(cost.batchCost),
    cost_per_serving: s(cost.servingCost),
    yield_rate: s(cost.yieldRate),
    menu_price: s(metrics.menuPrice),
    food_cost_rate: s(metrics.foodCostRate),
    detail: {
      as_of: asOf,
      issues: cost.issues,
      lines: cost.lines.map((l) => ({
        line_id: l.lineId,
        kind: l.kind,
        name: l.name,
        quantity: s(l.quantity),
        unit: l.unit,
        base_qty: s(l.baseQty),
        base_unit: l.baseUnit,
        waste_rate: l.wasteRate.toString(),
        purchase_qty: s(l.purchaseQty),
        unit_cost: s(l.unitCost),
        cost: s(l.cost),
        purchase_price_id: l.priceId,
        component_version_id: l.componentVersionId,
      })),
    },
  };
}
