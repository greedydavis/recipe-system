import { describe, expect, it } from 'vitest';
import { computeVersionCost, ingredientUnitCost } from './costing';
import { dec } from './decimal';
import { formatBatchCost, formatPercent, formatQty, formatServingCost } from './format';
import { priceMetrics } from './pricing';
import { scaleFactor } from './scaling';
import { dish, expected, goldenBundle, ingredients, soup } from './__fixtures__/golden/signature-noodle';

const p10 = (v: { toFixed(dp: number): string } | null) => (v ? v.toFixed(10) : null);

describe('黃金範例：招牌湯底 → 招牌湯麵', () => {
  it('原物料單位成本', () => {
    for (const [key, ing] of Object.entries(ingredients)) {
      const r = ingredientUnitCost(ing);
      expect(r.ok, key).toBe(true);
      if (r.ok) expect(p10(r.value.perBase), key).toBe(expected.unitCost[key as keyof typeof expected.unitCost]);
    }
  });

  it('湯底批次成本、出成率、每份成本', () => {
    const c = computeVersionCost(goldenBundle, soup.id);
    expect(c.isComplete).toBe(true);
    expect(c.lines.map((l) => p10(l.cost))).toEqual(expected.soup.lineCosts);
    expect(p10(c.lines[1].purchaseQty)).toBe(expected.soup.onionPurchaseQty);
    expect(p10(c.batchCost)).toBe(expected.soup.batchCost);
    expect(p10(c.inputWeightG)).toBe(expected.soup.inputWeightG);
    expect(p10(c.yieldRate)).toBe(expected.soup.yieldRate);
    expect(p10(c.servingsPerBatch)).toBe(expected.soup.servingsPerBatch);
    expect(p10(c.servingCost)).toBe(expected.soup.servingCost);
    expect(formatServingCost(c.servingCost)).toBe(expected.display.soupServingCost);
    expect(formatBatchCost(c.batchCost)).toBe(expected.display.soupBatchCost);
  });

  it('湯麵每份成本、食材成本率、毛利率、建議售價', () => {
    const c = computeVersionCost(goldenBundle, dish.id);
    expect(c.isComplete).toBe(true);
    expect(c.lines.map((l) => p10(l.cost))).toEqual(expected.dish.lineCosts);
    expect(p10(c.servingCost)).toBe(expected.dish.servingCost);
    const m = priceMetrics(c.servingCost, dish, goldenBundle.settings);
    expect(p10(m.netPrice)).toBe(expected.dish.netPrice);
    expect(p10(m.foodCostRate)).toBe(expected.dish.foodCostRate);
    expect(p10(m.grossMarginRate)).toBe(expected.dish.grossMarginRate);
    expect(m.suggestedPrice?.toString()).toBe(expected.dish.suggestedPrice);
    expect(formatServingCost(c.servingCost)).toBe(expected.display.dishServingCost);
    expect(formatPercent(m.foodCostRate)).toBe(expected.display.foodCostRate);
    expect(formatPercent(m.grossMarginRate)).toBe(expected.display.grossMarginRate);
  });

  it('份量換算：湯麵 10 份、湯底自訂產量 30,000 g', () => {
    const ten = scaleFactor(dish, { kind: 'servings', servings: 10 });
    expect(ten.ok && ten.value.toString()).toBe('10');
    const qtys = dish.lines.map((l) => (ten.ok ? dec(l.quantity!).mul(ten.value).toString() : null));
    expect(qtys).toEqual(['4200', '1500', '100', '10']);

    const custom = scaleFactor(soup, { kind: 'output', qty: 30000, unit: 'g' });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.value.toFixed(6)).toBe('1.428571');
    const scaled = soup.lines.map((l) => formatQty(dec(l.quantity!).mul(custom.value), l.unit));
    expect(scaled).toEqual(['14,286', '2,857', '42.86']);
  });
});
