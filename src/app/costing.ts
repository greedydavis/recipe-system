import { useMemo } from 'react';
import { useRpc } from '../data/api';
import { CostCalculator, type VersionCost } from '../domain/costing';
import { type PriceMetrics, priceMetrics } from '../domain/pricing';
import type { CostingBundle } from '../domain/types';

export interface CostView {
  cost: VersionCost;
  metrics: PriceMetrics;
}

/** 取得多個版本的成本（含巢狀元件），在前端用 src/domain 計算 */
export function useCosts(versionIds: string[], enabled = true) {
  const ids = useMemo(() => [...new Set(versionIds)].sort(), [versionIds]);
  const query = useRpc<CostingBundle>('get_costing_bundle', { p_version_ids: ids }, { enabled: enabled && ids.length > 0 });
  const views = useMemo(() => {
    const bundle = query.data;
    if (!bundle) return null;
    const calc = new CostCalculator(bundle);
    const map = new Map<string, CostView>();
    for (const id of ids) {
      if (!bundle.versions[id]) continue;
      const cost = calc.version(id);
      map.set(id, { cost, metrics: priceMetrics(cost.servingCost, bundle.versions[id], bundle.settings) });
    }
    return map;
  }, [query.data, ids]);
  return { ...query, bundle: query.data, views };
}
