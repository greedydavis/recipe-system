import { useMemo } from 'react';
import { useRpc } from '../data/api';
import { CostCalculator, type VersionCost } from '../domain/costing';
import { type PriceMetrics, priceMetrics } from '../domain/pricing';
import type { Dec } from '../domain/decimal';
import { formatLineCost, formatPercent, formatPrice, formatServingCost } from '../domain/format';
import type { CostingBundle } from '../domain/types';

export interface CostView {
  cost: VersionCost;
  metrics: PriceMetrics;
  /** 用成本下限算的食材成本率與建議售價；成本完整時和 metrics 相同 */
  minMetrics: PriceMetrics;
}

/** 成本下限要大於 0 才有意義（一項都還算不出來時就只顯示「不完整」） */
const positive = (v: Dec | null): v is Dec => !!v && v.gt(0);

/**
 * 每份成本的顯示：完整「$27.2」；不完整但算得出已知部分「至少 $10.3」；否則「不完整」。
 * 「至少」是只加總已經有價格與用量的部分，缺的項目補上後成本只會更高。
 */
export function servingCostLabel(view: CostView | undefined): string {
  if (!view) return '—';
  if (view.cost.isComplete) return `$${formatServingCost(view.cost.servingCost)}`;
  return positive(view.cost.minServingCost) ? `至少 $${formatServingCost(view.cost.minServingCost)}` : '不完整';
}

export function foodCostRateLabel(view: CostView | undefined): string {
  if (!view) return '—';
  if (view.cost.isComplete) return formatPercent(view.metrics.foodCostRate);
  const rate = view.minMetrics.foodCostRate;
  return positive(rate) ? `至少 ${formatPercent(rate)}` : '—';
}

export function suggestedPriceLabel(view: CostView | undefined): string {
  if (!view) return '—';
  if (view.cost.isComplete) return view.metrics.suggestedPrice ? `$${formatPrice(view.metrics.suggestedPrice)}` : '—';
  const price = view.minMetrics.suggestedPrice;
  return positive(view.cost.minServingCost) && price ? `至少 $${formatPrice(price)}` : '—';
}

/** 一行用料的成本：算得出來「$9.00」；只算得出下限「至少 $10.00」；否則 null */
export function lineCostLabel(line: { cost: Dec | null; minCost: Dec | null }): string | null {
  if (line.cost) return `$${formatLineCost(line.cost)}`;
  return positive(line.minCost) ? `至少 $${formatLineCost(line.minCost)}` : null;
}

/** 取得多個版本的成本（含巢狀元件），在前端用 src/domain 計算 */
export function useCosts(versionIds: string[], enabled = true) {
  // 呼叫端常常每次 render 都傳新的陣列；用內容當 key，避免每次都重算全部成本
  const key = [...new Set(versionIds)].sort().join(',');
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);
  const query = useRpc<CostingBundle>('get_costing_bundle', { p_version_ids: ids }, { enabled: enabled && ids.length > 0 });
  const views = useMemo(() => {
    const bundle = query.data;
    if (!bundle) return null;
    const calc = new CostCalculator(bundle);
    const map = new Map<string, CostView>();
    for (const id of ids) {
      if (!bundle.versions[id]) continue;
      const cost = calc.version(id);
      map.set(id, {
        cost,
        metrics: priceMetrics(cost.servingCost, bundle.versions[id], bundle.settings),
        minMetrics: priceMetrics(cost.minServingCost, bundle.versions[id], bundle.settings),
      });
    }
    return map;
  }, [query.data, ids]);
  return { ...query, bundle: query.data, views };
}
