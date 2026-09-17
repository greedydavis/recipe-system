import { D, type Dec, type Numeric, dec, decOrNull } from './decimal';
import type { CostingVersion, Settings } from './types';

export interface PriceMetrics {
  menuPrice: Dec | null;
  netPrice: Dec | null;
  foodCostRate: Dec | null;
  grossMarginRate: Dec | null;
  targetRate: Dec;
  suggestedPrice: Dec | null;
  overTarget: boolean;
}

/** 建議售價（含稅）：成本 ÷ 目標食材成本率 ×（1＋稅率），無條件進位到 roundTo 的倍數 */
export function suggestedPrice(servingCost: Dec, targetRate: Numeric, taxRate: Numeric, roundTo: Numeric): Dec {
  const raw = servingCost.div(dec(targetRate)).mul(new D(1).add(dec(taxRate)));
  const step = dec(roundTo);
  return raw.div(step).ceil().mul(step);
}

export function priceMetrics(
  servingCost: Dec | null,
  version: Pick<CostingVersion, 'menu_price' | 'target_food_cost_rate'>,
  settings: Settings,
): PriceMetrics {
  const targetRate = decOrNull(version.target_food_cost_rate) ?? dec(settings.target_food_cost_rate);
  const taxRate = dec(settings.sales_tax_rate);
  const menuPrice = version.menu_price ? dec(version.menu_price.price) : null;
  const netPrice = menuPrice ? menuPrice.div(new D(1).add(taxRate)) : null;
  if (!servingCost) {
    return {
      menuPrice,
      netPrice,
      foodCostRate: null,
      grossMarginRate: null,
      targetRate,
      suggestedPrice: null,
      overTarget: false,
    };
  }
  const foodCostRate = netPrice && netPrice.gt(0) ? servingCost.div(netPrice) : null;
  return {
    menuPrice,
    netPrice,
    foodCostRate,
    grossMarginRate: foodCostRate ? new D(1).sub(foodCostRate) : null,
    targetRate,
    suggestedPrice: suggestedPrice(servingCost, targetRate, taxRate, settings.price_round_to),
    overTarget: foodCostRate ? foodCostRate.gt(targetRate) : false,
  };
}
